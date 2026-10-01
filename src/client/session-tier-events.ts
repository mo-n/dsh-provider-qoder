import { qoderRpcPath, type QoderSessionTierScope } from '../dsh/rpc-channel.ts'

/** One authenticated host change stream shared by the mounted composer controls. */
export function createSessionTierEvents(send: typeof fetch = (...args) => globalThis.fetch(...args)) {
  const listeners = new Set<{ scope: QoderSessionTierScope; listener: () => void }>()
  let active: AbortController | undefined
  let disposed = false
  const notify = (scope?: QoderSessionTierScope) => {
    for (const entry of listeners) {
      if (!scope || (entry.scope.region === scope.region && entry.scope.sessionId === scope.sessionId && entry.scope.modelId === scope.modelId)) {
        try { entry.listener() } catch { /* Other mounted controls still need the event. */ }
      }
    }
  }
  const start = () => {
    if (active || disposed || !listeners.size) return
    const controller = new AbortController()
    active = controller
    void follow(controller).finally(() => { if (active === controller) active = undefined })
  }
  async function follow(controller: AbortController) {
    let delay = 1000
    while (!controller.signal.aborted) {
      try {
        const response = await send(qoderRpcPath('sessionTierEvents'), {
          method: 'POST', credentials: 'include', signal: controller.signal,
          headers: { 'content-type': 'application/json' }, body: '{}',
        })
        if (!response.ok || !response.body) throw new Error('Context tier stream unavailable')
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffered = ''
        try {
          while (!controller.signal.aborted) {
            const { value, done } = await reader.read()
            if (done) break
            buffered += decoder.decode(value, { stream: true })
            let newline: number
            while ((newline = buffered.indexOf('\n')) >= 0) {
              const item = JSON.parse(buffered.slice(0, newline))
              buffered = buffered.slice(newline + 1)
              delay = 1000
              if (item.ready === true) notify()
              else if ((item.region === 'global' || item.region === 'china') && typeof item.sessionId === 'string' && typeof item.modelId === 'string') notify(item)
            }
          }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
      } catch { /* Reconnect also rereads the host, covering events missed while disconnected. */ }
      if (controller.signal.aborted) break
      await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', finish); resolve() }
        const timer = setTimeout(finish, delay)
        controller.signal.addEventListener('abort', finish, { once: true })
      })
      delay = Math.min(delay * 2, 30000)
    }
  }
  return {
    subscribe(scope: QoderSessionTierScope, listener: () => void) {
      const entry = { scope, listener }
      listeners.add(entry)
      start()
      return () => {
        listeners.delete(entry)
        if (!listeners.size) { active?.abort(); active = undefined }
      }
    },
    dispose() { disposed = true; listeners.clear(); active?.abort(); active = undefined },
  }
}
