import type { QoderModelRate } from '../dsh/rpc-channel.ts'
import type { QoderRegion } from '../qoder/region.ts'
import type { QoderRpcCaller } from './rpc-client.ts'
import { regionOf, type QoderModelSettingsSection } from './credential-operations.ts'

interface ModelRatesSettings {
  subscribe(listener: () => void): () => void
  getSnapshot(): { value?: Pick<QoderModelSettingsSection, 'region' | 'showModelRates'> }
}

/** Share one catalog read across the visible Qoder model options. */
export function createModelRates(rpc: QoderRpcCaller, settings: ModelRatesSettings) {
  const empty = new Map<string, QoderModelRate>()
  let rates = empty
  let region: QoderRegion | undefined
  let request: AbortController | undefined
  const listeners = new Set<() => void>()

  const publish = (next: Map<string, QoderModelRate>) => {
    if (rates === next) return
    rates = next
    for (const listener of listeners) listener()
  }

  const enabledRegion = () => {
    const { value } = settings.getSnapshot()
    if (value !== undefined && value.showModelRates !== false) return regionOf(value)
  }

  const refresh = (nextRegion: QoderRegion | undefined) => {
    if (listeners.size === 0) return
    request?.abort()
    request = undefined
    if (region !== nextRegion) {
      region = nextRegion
      publish(empty)
    }
    if (nextRegion === undefined) return
    const pending = new AbortController()
    request = pending
    void rpc.call('modelRates', {}, pending.signal).then(result => {
      if (request !== pending) return
      request = undefined
      if (!result.ok) return
      publish(result.value.region === nextRegion
        ? new Map(result.value.rates.map(rate => [rate.id, rate]))
        : empty)
    })
  }

  const unsubscribeSettings = settings.subscribe(() => {
    const nextRegion = enabledRegion()
    if (nextRegion !== region) refresh(nextRegion)
  })

  return {
    refresh: () => refresh(enabledRegion()),
    dispose() {
      unsubscribeSettings()
      request?.abort()
      request = undefined
      rates = empty
      listeners.clear()
    },
    getSnapshot: (): ReadonlyMap<string, QoderModelRate> => rates,
    subscribe(listener: () => void) {
      listeners.add(listener)
      if (listeners.size === 1) refresh(enabledRegion())
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
