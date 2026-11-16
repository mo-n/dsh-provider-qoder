import type { QoderModelRate } from '../dsh/rpc-channel.ts'
import type { QoderRpcCaller } from './rpc-client.ts'

/** Share one catalog read across the visible Qoder model options. */
export function createModelRates(rpc: QoderRpcCaller) {
  const empty = new Map<string, QoderModelRate>()
  let rates = empty
  let request: AbortController | undefined
  const listeners = new Set<() => void>()

  const publish = (next: Map<string, QoderModelRate>) => {
    if (rates === next) return
    rates = next
    for (const listener of listeners) listener()
  }

  const refresh = () => {
    if (listeners.size === 0) return
    request?.abort()
    const pending = new AbortController()
    request = pending
    void rpc.call('modelRates', {}, pending.signal).then(result => {
      if (request !== pending) return
      request = undefined
      if (result.ok) publish(new Map(result.value.map(rate => [rate.id, rate])))
    })
  }

  return {
    refresh,
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
