import test from 'node:test'
import assert from 'node:assert/strict'
import { createCatalogEvents } from '../src/client/catalog-events.ts'
import { createQoderRpcCaller } from '../src/client/rpc-client.ts'
import type { QoderCatalogStatus } from '../src/dsh/rpc-channel.ts'
import { nextTurn } from './helpers/timing.ts'

test('catalog status falls back to a shared JSON read while the event stream is unavailable', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let status: QoderCatalogStatus = { region: 'global', refreshing: false }
  let reads = 0
  const send: typeof fetch = async url => {
    if (String(url).endsWith('/catalogEvents')) return new Response(null, { status: 503 })
    assert.ok(String(url).endsWith('/catalogStatus'))
    reads++
    return Response.json({ ok: true, value: status })
  }
  const rpc = createQoderRpcCaller({ fetch: send })
  const events = createCatalogEvents(rpc, send)
  t.after(() => events.dispose())
  const first: Array<boolean | undefined> = []
  const second: Array<boolean | undefined> = []
  const stopFirst = events.subscribe('global', value => first.push(value?.refreshing))
  const stopSecond = events.subscribe('global', value => second.push(value?.refreshing))
  await nextTurn()
  assert.deepEqual(first, [undefined, false])
  assert.deepEqual(second, first)
  assert.equal(reads, 1)
  status = { region: 'global', refreshing: true }
  t.mock.timers.tick(1000)
  await nextTurn()
  assert.deepEqual(first, [undefined, false, true])
  assert.deepEqual(second, first)
  assert.equal(reads, 2)
  stopFirst()
  stopSecond()
  t.mock.timers.tick(3000)
  await nextTurn()
  assert.equal(reads, 2)
})


test('unsubscribing in the disconnect notification does not restart fallback polling', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let polls = 0
  let stream!: ReadableStreamDefaultController<Uint8Array>
  const send: typeof fetch = async url => {
    if (String(url).endsWith('/catalogEvents')) {
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller } }))
    }
    polls++
    return Response.json({ ok: true, value: { region: 'global', refreshing: false } })
  }
  const events = createCatalogEvents(createQoderRpcCaller({ fetch: send }), send)
  t.after(() => events.dispose())
  let sawStream = false
  const leave = events.subscribe('global', status => {
    if (status?.refreshing) sawStream = true
    if (!status && sawStream) leave()
  })
  stream.enqueue(new TextEncoder().encode('{"region":"global","refreshing":true}\n'))
  await nextTurn()
  assert.ok(sawStream)
  assert.equal(polls, 1)
  stream.close()
  await nextTurn()
  t.mock.timers.tick(1000)
  await nextTurn()
  assert.equal(polls, 1)
})
