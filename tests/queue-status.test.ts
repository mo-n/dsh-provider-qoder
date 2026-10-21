import test from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { QoderQueueStatusStore } from '../src/dsh/queue-status.ts'
import { parseQueueSnapshots, watchQueueStatus, type QueueViewState } from '../src/client/queue-status.ts'
import type { QoderRpcCaller } from '../src/client/rpc-client.ts'
import type { QoderQueueSnapshot } from '../src/qoder/queue.ts'

function snapshot(callId = 'call', sessionId = 'session'): QoderQueueSnapshot {
  return { callId, sessionId, model: 'model', waitElapsedMs: 0, maxWaitMs: 3_600_000, updatedAt: 1000 }
}

class Visibility extends EventTarget {
  hidden = false
  setHidden(hidden: boolean): void { this.hidden = hidden; this.dispatchEvent(new Event('visibilitychange')) }
}

test('queue snapshots isolate calls and sessions and survive unrelated call completion', () => {
  const store = new QoderQueueStatusStore()
  store.update({ type: 'waiting', snapshot: snapshot('old') })
  store.update({ type: 'waiting', snapshot: snapshot('new') })
  store.update({ type: 'waiting', snapshot: snapshot('other', 'another-session') })
  store.update({ type: 'clear', callId: 'old' })
  assert.deepEqual(store.read('session').map(item => item.callId), ['new'])
  assert.equal(store.read('another-session').length, 1)
  store.read('session')[0].model = 'mutated'
  assert.equal(store.read('session')[0].model, 'model')
  store.dispose()
  store.update({ type: 'waiting', snapshot: snapshot() })
  assert.deepEqual(store.read('session'), [])
})

test('browser snapshots reject cross-session and malformed responses', () => {
  assert.deepEqual(parseQueueSnapshots([snapshot()], 'session'), [snapshot()])
  assert.throws(() => parseQueueSnapshots([snapshot()], 'other'))
  assert.throws(() => parseQueueSnapshots([{ ...snapshot(), waitTimeMs: Infinity }], 'session'))
  assert.throws(() => parseQueueSnapshots({ items: [] }, 'session'))
})

test('visible polling marks failures stale and recovers without retaining finished entries', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const visibility = new Visibility()
  const views: QueueViewState[] = []
  let reads = 0
  const rpc = { call: async (endpoint: string, payload: unknown) => {
    assert.equal(endpoint, 'queue')
    assert.deepEqual(payload, { sessionId: 'session' })
    reads++
    return reads === 2 ? { ok: false, error: { code: 'INTERNAL', message: 'offline' } } : { ok: true, value: reads === 1 ? [snapshot()] : [] }
  } } as QoderRpcCaller
  const stop = watchQueueStatus(rpc, 'session', visibility, state => views.push(state))
  t.after(stop)
  await setImmediate()
  assert.equal(views.at(-1)?.items.length, 1)
  t.mock.timers.tick(1000)
  await setImmediate()
  assert.equal(views.at(-1)?.unavailable, true)
  t.mock.timers.tick(1000)
  await setImmediate()
  assert.deepEqual(views.at(-1), { items: [], unavailable: false })
  visibility.setHidden(true)
  t.mock.timers.tick(10_000)
  await setImmediate()
  assert.equal(reads, 3)
  visibility.setHidden(false)
  await setImmediate()
  assert.equal(reads, 4)
  stop()
  t.mock.timers.tick(10_000)
  assert.equal(reads, 4)
})

test('hidden and disposed components cancel requests and ignore late responses', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const visibility = new Visibility()
  const views: QueueViewState[] = []
  const pending: Array<{ signal: AbortSignal; resolve: (value: unknown) => void }> = []
  const rpc = { call: (_endpoint: unknown, _payload: unknown, signal: AbortSignal) => new Promise<unknown>(resolve => pending.push({ signal, resolve })) } as QoderRpcCaller
  const stop = watchQueueStatus(rpc, 'session', visibility, state => views.push(state))
  t.after(stop)
  t.mock.timers.tick(2000)
  assert.equal(pending.length, 1, 'no overlapping refresh while a request is pending')
  visibility.setHidden(true)
  assert.equal(pending[0].signal.aborted, true)
  visibility.setHidden(false)
  assert.equal(pending.length, 2)
  pending[0].resolve({ ok: true, value: [snapshot('obsolete')] })
  await setImmediate()
  assert.equal(views.length, 0)
  stop()
  assert.equal(pending[1].signal.aborted, true)
  pending[1].resolve({ ok: true, value: [snapshot()] })
  await setImmediate()
  assert.equal(views.length, 0)
})
