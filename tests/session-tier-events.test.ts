import { mockTime, nextTurn } from './helpers/timing.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import type { QoderSessionTierScope } from '../src/dsh/rpc-channel.ts'
import { registerQoderRpc } from '../src/dsh/rpc.ts'
import { createSessionTierEvents } from '../src/client/session-tier-events.ts'

const scope: QoderSessionTierScope = { region: 'global', sessionId: 's', modelId: 'a' }
const settle = nextTurn
function fixture() {
  const routes: ConnectionFetchRoute[] = []
  const listeners = new Set<(scope: QoderSessionTierScope) => void>()
  const ctx = { connection: { fetch: { register(route: ConnectionFetchRoute) { routes.push(route); return () => {} } } } } as unknown as Context
  const dispose = registerQoderRpc(ctx, async () => ({ ok: true, value: {} }), listener => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  })
  const route = routes.find(route => route.path.endsWith('/sessionTierEvents'))!
  return { route, dispose, listeners, emit: (value: QoderSessionTierScope) => { for (const listener of listeners) listener(value) } }
}

test('host stream announces readiness, publishes changes and releases subscriptions on cancellation', async () => {
  const { route, listeners, emit, dispose } = fixture()
  const response = await route.fetch(new Request('http://localhost/api/qoder-subscription/sessionTierEvents', { method: 'POST' }))
  assert.equal(response.headers.get('content-type'), 'application/x-ndjson')
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const reader = response.body!.getReader()
  assert.deepEqual(JSON.parse(new TextDecoder().decode((await reader.read()).value)), { ready: true })
  emit(scope)
  assert.deepEqual(JSON.parse(new TextDecoder().decode((await reader.read()).value)), scope)
  await reader.cancel()
  assert.equal(listeners.size, 0)
  dispose()
})

test('aborted requests and plugin disposal close all host streams', async () => {
  const { route, listeners, dispose } = fixture()
  const abort = new AbortController()
  const response = await route.fetch(new Request('http://localhost/events', { method: 'POST', signal: abort.signal }))
  const reader = response.body!.getReader()
  await reader.read()
  abort.abort()
  assert.equal((await reader.read()).done, true)
  assert.equal(listeners.size, 0)
  const other = await route.fetch(new Request('http://localhost/events', { method: 'POST' }))
  const second = other.body!.getReader()
  await second.read()
  dispose()
  assert.equal((await second.read()).done, true)
  assert.equal(listeners.size, 0)
})

test('client shares one authenticated stream, filters scopes and cancels after the last view leaves', async () => {
  const host = fixture()
  let calls = 0
  const events = createSessionTierEvents(async (input, init) => {
    calls++
    assert.equal(init?.credentials, 'include')
    return host.route.fetch(new Request(`http://localhost${input}`, init))
  })
  let first = 0, second = 0, other = 0
  const offA = events.subscribe(scope, () => first++)
  const offB = events.subscribe(scope, () => second++)
  const offOther = events.subscribe({ ...scope, region: 'china' }, () => other++)
  await settle()
  assert.equal(calls, 1)
  assert.equal(first, 1); assert.equal(second, 1); assert.equal(other, 1)
  host.emit(scope); await settle()
  assert.equal(first, 2); assert.equal(second, 2); assert.equal(other, 1)
  offA(); offB()
  assert.equal(host.listeners.size, 1)
  offOther(); await settle()
  assert.equal(host.listeners.size, 0)
  events.dispose(); host.dispose()
})

test('client decodes split records and reconnects with a fresh readiness notification', async t => {
  const time = mockTime(t)
  const encoder = new TextEncoder()
  let calls = 0
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const events = createSessionTierEvents(async (_input, init) => {
    calls++
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value
        value.enqueue(encoder.encode('{"rea'))
        value.enqueue(encoder.encode('dy":true}\n'))
        init?.signal?.addEventListener('abort', () => { try { value.close() } catch {} }, { once: true })
      },
    })
    return new Response(body)
  })
  let notifications = 0
  const off = events.subscribe(scope, () => notifications++)
  await settle()
  assert.equal(notifications, 1)
  controller.close()
  await settle() // Closing the stream schedules reconnect after reader cleanup.
  time.tick(999)
  assert.equal(calls, 1)
  assert.equal(notifications, 1)
  time.tick(1)
  await settle()
  assert.equal(calls, 2)
  assert.equal(notifications, 2)
  off(); events.dispose()
})

test('client skips malformed, null, array and oversized records without reconnecting', async t => {
  const time = mockTime(t)
  const encoder = new TextEncoder()
  let calls = 0
  const events = createSessionTierEvents(async (_input, init) => {
    calls++
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(encoder.encode([
          'null',
          '[]',
          '{"broken"',
          'x'.repeat(64 * 1024 + 1),
          JSON.stringify({ ready: true }),
          JSON.stringify(scope),
        ].join('\n') + '\n'))
        init?.signal?.addEventListener('abort', () => { try { stream.close() } catch {} }, { once: true })
      },
    })
    return new Response(body)
  })
  let notifications = 0
  const off = events.subscribe(scope, () => notifications++)
  await settle()
  assert.equal(calls, 1)
  assert.equal(notifications, 3, 'an oversized line triggers one safe global invalidation')
  time.tick(999)
  assert.equal(calls, 1)
  off(); events.dispose()
  await settle()
})

test('client globally invalidates for an oversized scoped record and continues the stream', async t => {
  const time = mockTime(t)
  const encoder = new TextEncoder()
  let calls = 0
  const oversized = { ...scope, modelId: 'x'.repeat(70 * 1024) }
  const events = createSessionTierEvents(async (_input, init) => {
    calls++
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        const records = encoder.encode(JSON.stringify(oversized) + '\n' + JSON.stringify(scope) + '\n')
        const split = 64 * 1024 + 1
        stream.enqueue(records.slice(0, split))
        // Once dropped, further chunks of this same logical line must not
        // cause additional global invalidations.
        stream.enqueue(records.slice(split, split + 128))
        stream.enqueue(records.slice(split + 128))
        init?.signal?.addEventListener('abort', () => { try { stream.close() } catch {} }, { once: true })
      },
    })
    return new Response(body)
  })
  const otherScope = { ...scope, modelId: 'other' }
  let matching = 0
  let other = 0
  const offMatching = events.subscribe(scope, () => matching++)
  const offOther = events.subscribe(otherScope, () => other++)
  await settle()
  assert.equal(calls, 1)
  assert.equal(matching, 2, 'the oversized event and the following scoped event each invalidate this view')
  assert.equal(other, 1, 'an oversized scoped event uses one global invalidation')
  time.tick(999)
  assert.equal(calls, 1)
  offMatching(); offOther(); events.dispose()
  await settle()
})

test('a line exactly at the UTF-8 byte limit remains a valid event', async () => {
  const encoder = new TextEncoder()
  const fixed = '{"region":"global","sessionId":"s","modelId":"'
  const suffix = '"}'
  const modelId = 'x'.repeat(64 * 1024 - encoder.encode(fixed + suffix).byteLength)
  const record = fixed + modelId + suffix
  assert.equal(encoder.encode(record).byteLength, 64 * 1024)
  let notifications = 0
  let otherNotifications = 0
  const events = createSessionTierEvents(async () => new Response(new ReadableStream<Uint8Array>({
    start(stream) { stream.enqueue(encoder.encode(record + '\n')) },
  })))
  const off = events.subscribe({ ...scope, modelId }, () => notifications++)
  const offOther = events.subscribe(scope, () => otherNotifications++)
  await settle()
  assert.equal(notifications, 1)
  assert.equal(otherNotifications, 0, 'an exact-limit record must be parsed, not dropped with a global invalidation')
  off(); offOther(); events.dispose()
  await settle()
})

test('client bounds partial lines without rejecting a large chunk of valid records', async () => {
  const encoder = new TextEncoder()
  let calls = 0
  const count = 2000
  const events = createSessionTierEvents(async () => {
    calls++
    return new Response(new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(encoder.encode(Array.from({ length: count }, () => JSON.stringify(scope)).join('\n') + '\n'))
      },
    }))
  })
  let notifications = 0
  const off = events.subscribe(scope, () => notifications++)
  await settle()
  assert.equal(calls, 1)
  assert.equal(notifications, count)
  off(); events.dispose()
  await settle()
})

test('client limits a split multibyte line by UTF-8 bytes and resumes after its newline', async () => {
  const encoder = new TextEncoder()
  let stream!: ReadableStreamDefaultController<Uint8Array>
  let calls = 0
  const events = createSessionTierEvents(async () => {
    calls++
    return new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller } }))
  })
  let notifications = 0
  const off = events.subscribe(scope, () => notifications++)
  await settle()
  stream.enqueue(encoder.encode('{"ready":true,"padding":"' + '界'.repeat(11000)))
  await settle()
  assert.equal(notifications, 0)
  // The complete record is valid JSON and shorter than 64 Ki characters, but
  // exceeds 64 KiB in UTF-8. The oversized line causes one global invalidation;
  // the following scoped event is still delivered normally.
  stream.enqueue(encoder.encode('界'.repeat(11000) + '"}\n' + JSON.stringify(scope) + '\n'))
  await settle()
  assert.equal(notifications, 2)
  assert.equal(calls, 1)
  off(); events.dispose()
  await settle()
})

test('client decodes a scoped non-ASCII model id split inside a UTF-8 character', async () => {
  const encoder = new TextEncoder()
  const modelId = '模型-高容量'
  const event = encoder.encode(JSON.stringify({ ...scope, modelId }) + '\n')
  const split = event.findIndex((byte, index) => index > 0 && (byte & 0xc0) === 0x80)
  assert.ok(split > 0)
  let notifications = 0
  const events = createSessionTierEvents(async () => new Response(new ReadableStream<Uint8Array>({
    start(stream) {
      stream.enqueue(event.slice(0, split))
      stream.enqueue(event.slice(split))
    },
  })))
  const off = events.subscribe({ ...scope, modelId }, () => notifications++)
  await settle()
  assert.equal(notifications, 1)
  off(); events.dispose()
  await settle()
})
