import test from 'node:test'
import assert from 'node:assert/strict'
import { SessionTierState } from '../src/client/session-tier-state.ts'
import { QoderAdapter } from '../src/dsh/adapter.ts'
import { QODER_PROVIDER_ID } from '../src/dsh/provider.ts'
import type { QoderTransport } from '../src/qoder/transport/index.ts'
import type { QoderRegion } from '../src/qoder/region.ts'
import type { QoderSessionTierScope, QoderSessionTierSelection } from '../src/dsh/rpc-channel.ts'

const scope: QoderSessionTierScope = { region: 'global', sessionId: 's', modelId: 'a' }
const model = { id: 'a', name: 'A', contextTier: 'large', contextWindow: 1_000_000,
  contextOptions: { small: { tokenCount: 200_000 }, large: { tokenCount: 1_000_000 } } }
const selection = (tierKey = 'large', owner = scope): QoderSessionTierSelection => ({ ...owner, tierKey, tokenCount: tierKey === 'small' ? 200_000 : 1_000_000 })
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve() }
function host() {
  let region: QoderRegion = 'global'
  const adapter = new QoderAdapter({ models: [model], region: () => region, resolveTransport: () => ({}) as QoderTransport })
  const operations = {
    readSessionTier: async (owner: QoderSessionTierScope) => adapter.readSessionTier(owner),
    setSessionTier: async (sessionId: string, modelId: string, tierKey: string, region: QoderRegion) => {
      adapter.setSessionTier(sessionId, modelId, tierKey, region)
      return adapter.readSessionTier({ sessionId, modelId, region })
    },
    subscribeSessionTiers: (owner: QoderSessionTierScope, listener: () => void) => adapter.subscribeSessionTiers(changed => {
      if (JSON.stringify(changed) === JSON.stringify(owner)) listener()
    }),
  }
  return { adapter, operations, setRegion: (value: QoderRegion) => { region = value } }
}

test('a remounted composer restores the accepted manual tier before any model request', async () => {
  const { adapter, operations } = host()
  const first = new SessionTierState(scope, operations)
  first.activate(); await settle()
  await first.select('small'); await settle()
  assert.equal(first.getSnapshot().selection?.tierKey, 'small')
  assert.equal(adapter.resolveEffectiveModelForSession('a', 'other')?.contextWindow, 1_000_000)
  assert.equal(model.contextTier, 'large')
  first.dispose()
  const remounted = new SessionTierState(scope, operations)
  assert.equal(remounted.getSnapshot().selection, undefined)
  assert.equal(remounted.getSnapshot().loading, true)
  remounted.activate(); await settle()
  assert.equal(remounted.getSnapshot().selection?.tokenCount, adapter.resolveEffectiveModelForSession('a', 's')?.contextWindow)
  await remounted.select('large'); await settle()
  assert.equal(adapter.getSessionTier('s', 'a'), 'large')
  remounted.dispose()
})

test('two windows converge to the host choice and ignore changes to other sessions', async () => {
  const { operations, adapter } = host()
  const a = new SessionTierState(scope, operations)
  const b = new SessionTierState(scope, operations)
  a.activate(); b.activate(); await settle()
  await a.select('small'); await settle()
  assert.equal(b.getSnapshot().selection?.tierKey, 'small')
  adapter.setSessionTier('other', 'a', 'large'); await settle()
  assert.equal(b.getSnapshot().selection?.tierKey, 'small')
  await b.select('large'); await settle()
  assert.equal(a.getSnapshot().selection?.tierKey, 'large')
  a.dispose(); b.dispose()
})

test('scope isolation survives switching region away and back', async () => {
  const { operations, adapter, setRegion } = host()
  adapter.setSessionTier('s', 'a', 'small')
  const global = new SessionTierState(scope, operations)
  global.activate(); await settle(); global.dispose()
  setRegion('china')
  const china = new SessionTierState({ ...scope, region: 'china' }, operations)
  china.activate(); await settle()
  assert.equal(china.getSnapshot().selection?.tierKey, 'large')
  await china.select('large'); china.dispose()
  setRegion('global')
  global.activate(); await settle()
  assert.equal(global.getSnapshot().selection?.tierKey, 'small')
  assert.throws(() => adapter.readSessionTier({ ...scope, region: 'china' }), /scope/)
  global.dispose()
})

test('late reads cannot replace newer host change results', async () => {
  const requests: ReturnType<typeof deferred<QoderSessionTierSelection>>[] = []
  let changed = () => {}
  const state = new SessionTierState(scope, {
    readSessionTier: () => { const request = deferred<QoderSessionTierSelection>(); requests.push(request); return request.promise },
    subscribeSessionTiers: (_scope, listener) => { changed = listener; return () => {} },
  })
  state.activate(); changed()
  requests[1].resolve(selection('small')); await settle()
  requests[0].resolve(selection('large')); await settle()
  assert.equal(state.getSnapshot().selection?.tierKey, 'small')
  state.dispose()
})

test('a delayed write response cannot override another window newer selection', async () => {
  const write = deferred<QoderSessionTierSelection>()
  const current = selection()
  let changed = () => {}
  const state = new SessionTierState(scope, {
    readSessionTier: async () => current,
    setSessionTier: () => write.promise,
    subscribeSessionTiers: (_scope, listener) => { changed = listener; return () => {} },
  })
  state.activate(); await settle()
  const saving = state.select('small')
  changed(); await settle()
  write.resolve(selection('small')); await saving
  assert.equal(state.getSnapshot().selection?.tierKey, 'large')
  assert.equal(state.getSnapshot().saving, false)
  state.dispose()
})

test('failed writes retain the confirmed tier and support retry', async () => {
  let accepted = false
  let writes = 0
  const state = new SessionTierState(scope, {
    readSessionTier: async () => selection(),
    setSessionTier: async () => { writes++; if (!accepted) throw new Error('offline'); return selection('small') },
  })
  state.activate(); await settle()
  await state.select('small')
  assert.equal(state.getSnapshot().selection?.tierKey, 'large')
  assert.equal(state.getSnapshot().error, true)
  accepted = true; await state.select('small')
  assert.equal(state.getSnapshot().selection?.tierKey, 'small')
  assert.equal(state.getSnapshot().error, false)
  assert.equal(writes, 2)
  state.dispose()
})

test('failed initial reads show no inferred default and can be retried', async () => {
  let available = false
  const state = new SessionTierState(scope, { readSessionTier: async () => available ? selection('small') : undefined })
  state.activate(); await settle()
  assert.equal(state.getSnapshot().selection, undefined)
  assert.equal(state.getSnapshot().error, true)
  available = true; await state.refresh()
  assert.equal(state.getSnapshot().selection?.tierKey, 'small')
  state.dispose()
})

test('unmounted reads and writes cannot publish, including StrictMode reactivation', async () => {
  const write = deferred<QoderSessionTierSelection>()
  const state = new SessionTierState(scope, { readSessionTier: async () => selection(), setSessionTier: () => write.promise })
  state.activate(); await settle()
  const saving = state.select('small')
  state.dispose(); state.activate(); await settle()
  write.resolve(selection('small')); await saving
  assert.equal(state.getSnapshot().selection?.tierKey, 'large')
  state.dispose()
  const pending = deferred<QoderSessionTierSelection>()
  const other = new SessionTierState(scope, { readSessionTier: () => pending.promise })
  let updates = 0
  other.subscribe(() => updates++)
  other.activate(); other.dispose()
  const before = updates
  pending.resolve(selection('small')); await settle()
  assert.equal(updates, before)
})

test('read responses from another model or session are rejected', async () => {
  const state = new SessionTierState(scope, { readSessionTier: async () => selection('small', { ...scope, modelId: 'b' }) })
  state.activate(); await settle()
  assert.equal(state.getSnapshot().selection, undefined)
  assert.equal(state.getSnapshot().error, true)
  state.dispose()
})

test('host read uses the same historical fallback and manual precedence as generation', () => {
  const adapter = new QoderAdapter({ models: [model], resolveTransport: () => ({}) as QoderTransport,
    sessions: { get: id => id === 's' ? { requestContext: () => ({ provider: QODER_PROVIDER_ID, model: 'a', contextWindow: 200_000 }) } : undefined },
  })
  assert.equal(adapter.readSessionTier(scope).tokenCount, 200_000)
  adapter.setSessionTier('s', 'a', 'large')
  assert.equal(adapter.readSessionTier(scope).tokenCount, 1_000_000)
  assert.throws(() => adapter.readSessionTier({ ...scope, sessionId: 'missing' }), /scope/)
})
