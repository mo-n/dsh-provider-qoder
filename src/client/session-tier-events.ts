import { qoderRpcPath, type QoderSessionTierScope } from '../dsh/rpc-channel.ts'

// NDJSON is bounded per logical line in UTF-8 bytes. The limit applies to the
// current partial line, so a chunk containing many small valid lines is not
// rejected merely because the chunk itself is large.
const maxEventLineBytes = 64 * 1024

/** One authenticated host change stream shared by the mounted composer controls. */
export function createSessionTierEvents(send?: typeof fetch) {
  const events = createQoderChangeEvents('sessionTierEvents', value => {
    if ((value.region === 'global' || value.region === 'china')
      && typeof value.sessionId === 'string' && typeof value.modelId === 'string') {
      return { region: value.region, sessionId: value.sessionId, modelId: value.modelId } satisfies QoderSessionTierScope
    }
  }, send)
  return {
    subscribe(scope: QoderSessionTierScope, listener: () => void) {
      return events.subscribe(item => {
        if (!item || item.region === scope.region && item.sessionId === scope.sessionId && item.modelId === scope.modelId) listener()
      })
    },
    dispose: events.dispose,
  }
}

export function createQoderChangeEvents<T>(
  endpoint: 'sessionTierEvents' | 'catalogEvents',
  decode: (item: Record<string, unknown>) => T | undefined,
  send: typeof fetch = (...args) => globalThis.fetch(...args),
) {
  const listeners = new Set<(item?: T) => void>()
  let active: AbortController | undefined
  let disposed = false
  const notify = (item?: T) => {
    for (const listener of listeners) {
      try { listener(item) } catch { /* Other mounted controls still need the event. */ }
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
        const response = await send(qoderRpcPath(endpoint), {
          method: 'POST', credentials: 'include', signal: controller.signal,
          headers: { 'content-type': 'application/json' }, body: '{}',
        })
        if (!response.ok || !response.body) throw new Error('Qoder settings event stream unavailable')
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        const encoder = new TextEncoder()
        let line = ''
        let lineBytes = 0
        let droppingOversizedLine = false
        const resetLine = () => {
          line = ''
          lineBytes = 0
          droppingOversizedLine = false
        }
        const consume = (text: string) => {
          let offset = 0
          while (offset < text.length && !controller.signal.aborted) {
            const newline = text.indexOf('\n', offset)
            const end = newline < 0 ? text.length : newline
            const segment = text.slice(offset, end)
            if (!droppingOversizedLine) {
              const segmentBytes = encoder.encode(segment).byteLength
              if (lineBytes + segmentBytes > maxEventLineBytes) {
                // A model id has no provider-side length cap. Drop only this
                // logical line, but invalidate every mounted view once so a
                // legal oversized scope is recovered through a bounded host
                // reread rather than silently lost. Continue scanning the
                // same chunk for following records.
                delay = 1000
                notify()
                line = ''
                lineBytes = 0
                droppingOversizedLine = true
              } else {
                line += segment
                lineBytes += segmentBytes
              }
            }
            if (newline < 0) return
            if (!droppingOversizedLine && line.length > 0) {
              try {
                const item: unknown = JSON.parse(line)
                if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
                  const value = item as Record<string, unknown>
                  delay = 1000
                  if (value.ready === true && endpoint === 'sessionTierEvents') notify()
                  const decoded = decode(value)
                  if (decoded !== undefined) notify(decoded)
                }
              } catch {
                // One malformed record must not tear down the shared stream.
              }
            }
            resetLine()
            offset = newline + 1
          }
        }
        try {
          while (!controller.signal.aborted) {
            const { value, done } = await reader.read()
            if (done || controller.signal.aborted) break
            consume(decoder.decode(value, { stream: true }))
          }
          // Flush a split UTF-8 code point. A trailing unterminated record is
          // intentionally discarded because the host stream is NDJSON.
          if (!controller.signal.aborted) consume(decoder.decode())
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
      } catch { /* Reconnect also rereads the host, covering events missed while disconnected. */ }
      if (controller.signal.aborted) break
      if (endpoint === 'catalogEvents') notify()
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
    subscribe(listener: (item?: T) => void) {
      listeners.add(listener)
      start()
      return () => {
        listeners.delete(listener)
        if (!listeners.size) { active?.abort(); active = undefined }
      }
    },
    dispose() { disposed = true; listeners.clear(); active?.abort(); active = undefined },
  }
}
