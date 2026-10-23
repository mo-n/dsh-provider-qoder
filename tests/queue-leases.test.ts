import test from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { Session } from '@deepseek-ai/dsh-session'
import { SessionId, type TurnEndReason } from '@deepseek-ai/dsh-session/types'
import { bindQoderQueueLeases, QoderQueueLeases } from '../src/dsh/queue-leases.ts'
import type { QoderQueueLease } from '../src/qoder/queue.ts'

test('a run retains each model lease once across steps and isolates stale ends and other sessions', async () => {
  const runs = new QoderQueueLeases()
  const releases: string[] = []
  const lease = (key: string, sessionId = 'session'): QoderQueueLease => ({
    key, sessionId, release: async () => { releases.push(key) },
  })
  assert.equal(runs.retain(lease('standalone')), false)
  runs.start('session', 1)
  runs.start('other', 1)
  assert.equal(runs.retain(lease('model-a')), true)
  runs.start('session', 1)
  runs.retain(lease('model-a'))
  runs.retain(lease('model-b'))
  runs.retain(lease('other-model', 'other'))
  assert.deepEqual(releases, [])
  await runs.end('session', 0)
  assert.deepEqual(releases, [])
  await runs.end('session', 1)
  assert.deepEqual(releases, ['model-a', 'model-b'])
  await runs.end('session', 1)
  assert.equal(releases.length, 2)
  await runs.dispose()
  assert.deepEqual(releases, ['model-a', 'model-b', 'other-model'])
  assert.equal(runs.retain(lease('disposed')), false)
})

test('slow or rejected old cleanup cannot clear a new run', async () => {
  const runs = new QoderQueueLeases()
  let finish!: () => void
  const done = new Promise<void>(resolve => { finish = resolve })
  runs.start('session', 1)
  runs.retain({ key: 'old', sessionId: 'session', release: () => done })
  const closing = runs.end('session', 1)
  runs.start('session', 2)
  let released = 0
  runs.retain({ key: 'new', sessionId: 'session', release: async () => { released++; throw new Error('offline') } })
  finish()
  await closing
  await runs.end('session', 1)
  assert.equal(released, 0)
  await runs.end('session', 2)
  assert.equal(released, 1)
})

test('a captured old call cannot retain a lease in a newer turn, and unload awaits detached cleanup', async () => {
  const runs = new QoderQueueLeases()
  runs.start('session', 1)
  const oldOwner = runs.capture('session')
  assert.ok(oldOwner)
  let finish!: () => void
  const done = new Promise<void>(resolve => { finish = resolve })
  assert.equal(oldOwner.retain({ key: 'old', sessionId: 'session', release: () => done }), true)
  const closing = runs.end('session', 1)
  runs.start('session', 2)
  assert.equal(oldOwner.retain({ key: 'late', sessionId: 'session', release: async () => {} }), false)
  assert.notEqual(runs.capture('session')?.run, oldOwner.run)
  let disposed = false
  const unloading = runs.dispose().then(() => { disposed = true })
  await setImmediate()
  assert.equal(disposed, false)
  finish()
  await Promise.all([closing, unloading])
  assert.equal(disposed, true)
})

test('only committed turn/end releases leases, for success, failure and cancellation; listeners dispose', async () => {
  const ctx = new Context()
  const runs = new QoderQueueLeases()
  const fiber = ctx.plugin(scope => { bindQoderQueueLeases(scope, runs) })
  await fiber.await()
  const session = Session.create(SessionId('queue-lifecycle'))
  let released = 0
  const reasons: TurnEndReason[] = [
    { kind: 'completed' },
    { kind: 'error', error: { code: 'QODER_QUEUE_TIMEOUT', message: 'expired' } },
    { kind: 'aborted', reason: { kind: 'user' } },
  ]
  for (const [index, reason] of reasons.entries()) {
    const turn = index + 1
    // The real Session validates and creates the durable event; dispatch uses the public Host event.
    const start = session.append('turn/start', { turn })
    ctx.emit('session/event', session, start)
    runs.retain({ key: String(turn), sessionId: session.id, release: async () => { released++ } })
    assert.equal(released, index)
    const end = session.append('turn/end', { turn, reason })
    ctx.emit('session/event', session, end)
    await setImmediate()
    assert.equal(released, index + 1)
  }
  await fiber.dispose()
  const start = session.append('turn/start', { turn: 4 })
  ctx.emit('session/event', session, start)
  assert.equal(runs.retain({ key: 'after-unload', sessionId: session.id, release: async () => {} }), false)
  await runs.dispose()
})
