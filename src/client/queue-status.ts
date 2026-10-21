/** Poll plugin snapshots only; browser presence never controls upstream queue lifetime. */
import type { QoderQueueSnapshot } from '../qoder/queue.ts'
import type { QoderRpcCaller } from './rpc-client.ts'

export interface QueueViewState {
  items: readonly QoderQueueSnapshot[]
  unavailable: boolean
}

export function parseQueueSnapshots(value: unknown, sessionId: string): QoderQueueSnapshot[] {
  if (!Array.isArray(value) || value.length > 256) throw new Error('Invalid queue snapshots')
  return value.map(item => {
    if (!item || typeof item !== 'object'
      || item.sessionId !== sessionId || typeof item.callId !== 'string' || !item.callId
      || typeof item.model !== 'string'
      || !['waitElapsedMs', 'maxWaitMs', 'updatedAt'].every(key => typeof item[key] === 'number' && Number.isFinite(item[key]) && item[key] >= 0)
      || !['queueCount', 'waitTimeMs'].every(key => item[key] === undefined || (typeof item[key] === 'number' && Number.isFinite(item[key]) && item[key] >= 0))) {
      throw new Error('Invalid queue snapshot')
    }
    return item as QoderQueueSnapshot
  })
}

export function watchQueueStatus(
  rpc: QoderRpcCaller,
  sessionId: string,
  visibility: Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'>,
  changed: (state: QueueViewState) => void,
): () => void {
  let disposed = false
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let active: AbortController | undefined
  let items: readonly QoderQueueSnapshot[] = []
  const poll = async (): Promise<void> => {
    if (disposed || visibility.hidden || active) return
    const revision = generation
    const controller = new AbortController()
    active = controller
    const timeout = setTimeout(() => controller.abort(), 5000)
    try {
      const result = await rpc.call<unknown>('queue', { sessionId }, controller.signal)
      if (disposed || revision !== generation) return
      if (!result.ok) throw new Error('Queue status unavailable')
      items = parseQueueSnapshots(result.value, sessionId)
      changed({ items, unavailable: false })
    } catch {
      if (!disposed && revision === generation) changed({ items, unavailable: true })
    } finally {
      clearTimeout(timeout)
      if (active === controller) active = undefined
      if (!disposed && revision === generation && !visibility.hidden) timer = setTimeout(() => { void poll() }, 1000)
    }
  }
  const stop = (): void => {
    generation++
    clearTimeout(timer)
    active?.abort()
    active = undefined
  }
  const onVisibility = (): void => {
    stop()
    if (!visibility.hidden) void poll()
  }
  visibility.addEventListener('visibilitychange', onVisibility)
  void poll()
  return () => {
    disposed = true
    stop()
    visibility.removeEventListener('visibilitychange', onVisibility)
  }
}
