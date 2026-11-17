import type { QoderModelRate } from '../dsh/rpc-channel.ts'
import type { QoderRpcCaller } from './rpc-client.ts'
import type { QoderModelSettingsSection } from './credential-operations.ts'

export interface ModelRatesSettings {
  subscribe?(listener: () => void): () => void
  getSnapshot?(): { value?: Pick<QoderModelSettingsSection, 'showModelRates'> }
}

/** Share one catalog read across the visible Qoder model options. */
export function createModelRates(rpc: QoderRpcCaller, settings?: ModelRatesSettings) {
  const empty = new Map<string, QoderModelRate>()
  let rates = empty
  let request: AbortController | undefined
  const listeners = new Set<() => void>()

  const isEnabled = () => {
    try {
      return settings?.getSnapshot?.().value?.showModelRates !== false
    } catch {
      return true
    }
  }

  const publish = (next: Map<string, QoderModelRate>) => {
    if (rates === next) return
    rates = next
    for (const listener of listeners) listener()
  }

  const refresh = () => {
    if (listeners.size === 0) return
    request?.abort()
    if (!isEnabled()) {
      publish(empty)
      return
    }
    const pending = new AbortController()
    request = pending
    void rpc.call('modelRates', {}, pending.signal).then(result => {
      if (request !== pending) return
      request = undefined
      if (result.ok) publish(new Map(result.value.map(rate => [rate.id, rate])))
    })
  }

  const unsubscribeSettings = settings?.subscribe?.(() => {
    if (!isEnabled()) {
      request?.abort()
      request = undefined
      publish(empty)
    } else {
      refresh()
    }
  })

  return {
    refresh,
    dispose() {
      unsubscribeSettings?.()
      request?.abort()
      request = undefined
      rates = empty
      listeners.clear()
    },
    getSnapshot: (): ReadonlyMap<string, QoderModelRate> => rates,
    subscribe(listener: () => void) {
      listeners.add(listener)
      if (listeners.size === 1) refresh()
      return () => {
        listeners.delete(listener)
        if (listeners.size !== 0) return
        request?.abort()
        request = undefined
        rates = empty
      }
    },
  }
}
