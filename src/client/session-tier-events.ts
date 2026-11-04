import { qoderRpcPath, type QoderSessionTierScope } from '../dsh/rpc-channel.ts'

// NDJSON is bounded per logical line in UTF-8 bytes. The limit applies to the
// current partial line, so a chunk containing many small valid lines is not
// rejected merely because the chunk itself is large.
const maxEventLineBytes = 64 * 1024

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
        const encoder = new TextEncoder()
        let line = ''
        let lineBytes = 0
        let droppingOversizedLine = false
        const consume = (text: string) => {
          let offset = 0
          while (offset < text.length) {
            const newline = text.indexOf('\n', offset)
            const end = newline < 0 ? text.length : newline
            const segment = text.slice(offset, end)
            if (!droppingOversizedLine) {
              const segmentBytes = encoder.encode(segment).byteLength
              if (lineBytes + segmentBytes > maxEventLineBytes) {
                // Drop only this oversized logical line. Continue scanning the
                // same chunk so a following valid record is still delivered.
                line = ''
                lineBytes = 0
                droppingOversizedLine = true
              } else {
                line += segment
                lineBytes += segmentBytes
              }
            }
            if (newline < 0) return
            if (droppingOversizedLine) {
              droppingOversizedLine = false
            } else if (line.length > 0) {
              try {
                const item: unknown = JSON.parse(line)
                if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
                  const value = item as Record<string, unknown>
                  delay = 1000
                  if (value.ready === true) notify()
                  else if ((value.region === 'global' || value.region === 'china')
                    && typeof value.sessionId === 'string' && typeof value.modelId === 'string') {
                    notify({ region: value.region, sessionId: value.sessionId, modelId: value.modelId })
                  }
                }
              } catch {
                // One malformed record must not tear down the shared stream.
              }
            }
            line = ''
            lineBytes = 0
            offset = newline + 1
          }
        }
        try {
          while (!controller.signal.aborted) {
            const { value, done } = await reader.read()
            if (done) break
            consume(decoder.decode(value, { stream: true }))
          }
          // Flush a split UTF-8 code point. A trailing unterminated record is
          // intentionally discarded because the host stream is NDJSON.
          consume(decoder.decode())
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
