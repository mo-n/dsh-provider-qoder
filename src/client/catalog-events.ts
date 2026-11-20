import type { QoderCatalogStatus } from '../dsh/rpc-channel.ts'
import type { QoderRegion } from '../qoder/region.ts'
import type { QoderRpcCaller } from './rpc-client.ts'
import { createQoderChangeEvents } from './session-tier-events.ts'

type CatalogListener = (status?: QoderCatalogStatus) => void

interface CatalogSubscription {
  listeners: Set<CatalogListener>
  status?: QoderCatalogStatus
  streaming: boolean
  poll?: AbortController
  retry?: ReturnType<typeof setTimeout>
}

function decodeStatus(item: Record<string, unknown>): QoderCatalogStatus | undefined {
  const { region, refreshing, failure } = item
  if ((region === 'global' || region === 'china') && typeof refreshing === 'boolean') {
    return { region, refreshing, failure: failure === 'fetch' || failure === 'save' ? failure : undefined }
  }
}

export function createCatalogEvents(rpc: QoderRpcCaller, send?: typeof fetch) {
  const events = createQoderChangeEvents('catalogEvents', decodeStatus, send)
  const subscriptions = new Map<QoderRegion, CatalogSubscription>()
  const streamed = new Map<QoderRegion, QoderCatalogStatus>()
  let unsubscribeStream: (() => void) | undefined

  function publish(subscription: CatalogSubscription, status?: QoderCatalogStatus) {
    if (subscription.status?.refreshing === status?.refreshing && subscription.status?.failure === status?.failure) return
    subscription.status = status
    for (const listener of subscription.listeners) {
      try { listener(status) } catch { /* Continue notifying mounted settings pages. */ }
    }
  }

  function stopPolling(subscription: CatalogSubscription) {
    subscription.poll?.abort()
    subscription.poll = undefined
    clearTimeout(subscription.retry)
    subscription.retry = undefined
  }

  async function poll(region: QoderRegion, subscription: CatalogSubscription): Promise<void> {
    if (subscriptions.get(region) !== subscription || subscription.streaming || subscription.poll || subscription.retry !== undefined) return
    const controller = new AbortController()
    subscription.poll = controller
    const timeout = setTimeout(() => controller.abort(), 3000)
    try {
      const result = await rpc.call('catalogStatus', { region }, controller.signal)
      if (!controller.signal.aborted && result.ok && result.value?.region === region
        && typeof result.value.refreshing === 'boolean') publish(subscription, result.value)
    } catch {
      // The next poll or stream reconnect can recover the status.
    } finally {
      clearTimeout(timeout)
      if (subscription.poll === controller) {
        subscription.poll = undefined
        subscription.retry = setTimeout(() => {
          subscription.retry = undefined
          void poll(region, subscription)
        }, 1000)
      }
    }
  }

  function onEvent(status?: QoderCatalogStatus) {
    if (status) {
      streamed.set(status.region, status)
      const subscription = subscriptions.get(status.region)
      if (!subscription) return
      subscription.streaming = true
      stopPolling(subscription)
      publish(subscription, status)
      return
    }
    streamed.clear()
    for (const [region, subscription] of subscriptions) {
      if (subscription.streaming) publish(subscription, undefined)
      subscription.streaming = false
      void poll(region, subscription)
    }
  }

  return {
    subscribe(region: QoderRegion, listener: CatalogListener) {
      let subscription = subscriptions.get(region)
      if (!subscription) {
        const status = streamed.get(region)
        subscription = { listeners: new Set(), status, streaming: status !== undefined }
        subscriptions.set(region, subscription)
      }
      subscription.listeners.add(listener)
      listener(subscription.status)
      unsubscribeStream ??= events.subscribe(onEvent)
      void poll(region, subscription)
      return () => {
        if (!subscription.listeners.delete(listener) || subscription.listeners.size) return
        stopPolling(subscription)
        subscriptions.delete(region)
        if (!subscriptions.size) {
          unsubscribeStream?.()
          unsubscribeStream = undefined
          streamed.clear()
        }
      }
    },
    dispose() {
      events.dispose()
      unsubscribeStream = undefined
      for (const subscription of subscriptions.values()) stopPolling(subscription)
      subscriptions.clear()
      streamed.clear()
    },
  }
}
