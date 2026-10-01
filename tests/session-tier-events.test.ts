import test from 'node:test'
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import type { QoderSessionTierScope } from '../src/dsh/rpc-channel.ts'
import { registerQoderRpc } from '../src/dsh/rpc.ts'
import { createSessionTierEvents } from '../src/client/session-tier-events.ts'

const scope: QoderSessionTierScope = { region: 'global', sessionId: 's', modelId: 'a' }
async function settle() { for (let i = 0; i < 20; i++) await Promise.resolve() }
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

test('client decodes split records and reconnects with a fresh readiness notification', async () => {
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
  await new Promise(resolve => setTimeout(resolve, 1100))
  await settle()
  assert.equal(calls, 2)
  assert.equal(notifications, 2)
  off(); events.dispose()
})
