import test from 'node:test'
import assert from 'node:assert/strict'
import { deferred, nextTurn } from './helpers/timing.ts'
import { QoderModelCatalogEditor } from '../src/client/model-catalog-editor.ts'
import type { QoderCatalogEdit, QoderCatalogStatus, QoderRpcResult } from '../src/dsh/rpc-channel.ts'
import type { QoderCatalogModel } from '../src/qoder/catalog.ts'

const missing = { id: 'a', name: 'A', contextTier: 'large', missingFromCatalog: true, enabled: false }
const ready = { region: 'global', refreshing: false } as const

test('all mounted editors lock controls during a host refresh and unlock on failure', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const listeners = new Set<(status: QoderCatalogStatus) => void>()
  let edits = 0
  const operations = {
    subscribeCatalog: (_region: string, listener: (status: QoderCatalogStatus) => void) => {
      listeners.add(listener)
      listener(ready)
      return () => { listeners.delete(listener) }
    },
    editCatalog: async () => {
      edits++
      return { ok: true as const, value: [{ ...missing, enabled: true }] }
    },
  }
  const first = new QoderModelCatalogEditor('global', [missing], operations)
  const second = new QoderModelCatalogEditor('global', [missing], operations)
  first.activate()
  second.activate()
  for (const listener of listeners) listener({ ...ready, refreshing: true })
  const toggle = { action: 'toggle', id: 'a', enabled: true } as const
  await first.edit(toggle)
  await second.edit(toggle)
  assert.equal(edits, 0)
  for (const listener of listeners) listener({ ...ready, failure: 'save' })
  assert.deepEqual(first.getSnapshot().models, [missing])
  assert.equal(first.getSnapshot().status?.failure, 'save')
  void second.edit(toggle)
  t.mock.timers.tick(2000)
  await nextTurn()
  assert.equal(second.getSnapshot().models[0].enabled, true)
  first.dispose()
  second.dispose()
  assert.equal(listeners.size, 0)
})

test('a late acknowledgement cannot replace newer settings or a disposed region', async () => {
  const pending = deferred<QoderRpcResult<readonly QoderCatalogModel[]>>()
  const editor = new QoderModelCatalogEditor('global', [missing], { refreshCatalog: () => pending.promise })
  const refreshing = editor.discover()
  const latest = { id: 'b', name: 'New configuration' }
  editor.replaceModels([latest])
  pending.resolve({ ok: true, value: [] })
  await refreshing
  assert.deepEqual(editor.getSnapshot().models, [latest])
  editor.dispose()
  editor.replaceModels([])
  assert.deepEqual(editor.getSnapshot().models, [latest])
})

test('a failed manual refresh reports the save error without changing the saved list', async () => {
  const editor = new QoderModelCatalogEditor('global', [missing], {
    refreshCatalog: async () => ({ ok: false, error: { code: 'CATALOG_SAVE_FAILED', message: 'write failed' } }),
  })
  await editor.discover()
  assert.equal(editor.getSnapshot().failure, 'modelsUpdateNotSaved')
  assert.equal(editor.getSnapshot().pending, undefined)
  assert.deepEqual(editor.getSnapshot().models, [missing])
})

const other = { id: 'b', name: 'B', enabled: false }
const toggle = (id: string, enabled: boolean) => ({ action: 'toggle', id, enabled } as const)
const batch = (...items: ReturnType<typeof toggle>[]): QoderCatalogEdit => ({
  action: 'editBatch',
  changes: items.map(({ id, enabled }) => ({ id, enabled })),
})
const saveFailure = { ok: false, error: { code: 'INTERNAL', message: 'Save failed' } } as const
const bothEnabled = [{ ...missing, enabled: true }, { ...other, enabled: true }]

test('debounces multiple toggles into one batch and cancels a toggle restored to its saved value', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const calls: QoderCatalogEdit[] = []
  const editor = new QoderModelCatalogEditor('global', [missing, other], {
    editCatalog: async (_region, edit) => {
      calls.push(edit)
      return { ok: true, value: [missing, bothEnabled[1]] }
    },
  })
  void editor.edit(toggle('a', true))
  t.mock.timers.tick(1000)
  void editor.edit(toggle('b', true))
  void editor.edit(toggle('a', false))
  assert.deepEqual(editor.getSnapshot().viewModels, [missing, bothEnabled[1]])
  assert.equal(editor.getSnapshot().savingChanges, false)
  t.mock.timers.tick(1999)
  assert.deepEqual(calls, [])
  t.mock.timers.tick(1)
  await nextTurn()
  assert.deepEqual(calls, [batch(toggle('b', true))])
  assert.equal(editor.getSnapshot().hasPendingChanges, false)

  void editor.edit(toggle('a', true))
  void editor.edit(toggle('a', false))
  t.mock.timers.tick(5000)
  assert.equal(calls.length, 1)
})

test('continuous toggles flush a batch at five seconds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const calls: QoderCatalogEdit[] = []
  const editor = new QoderModelCatalogEditor('global', [missing, other], {
    editCatalog: async (_region, edit) => {
      calls.push(edit)
      return { ok: true, value: bothEnabled }
    },
  })
  void editor.edit(toggle('a', true))
  for (const enabled of [true, false, true, false, true]) {
    t.mock.timers.tick(900)
    void editor.edit(toggle('b', enabled))
  }
  t.mock.timers.tick(499)
  assert.deepEqual(calls, [])
  t.mock.timers.tick(1)
  await nextTurn()
  assert.deepEqual(calls, [batch(toggle('a', true), toggle('b', true))])
})

test('manual refresh flushes debounced changes and waits for the single batch to succeed', async () => {
  const write = deferred<QoderRpcResult<readonly QoderCatalogModel[]>>()
  const calls: (QoderCatalogEdit | string)[] = []
  const editor = new QoderModelCatalogEditor('global', [missing, other], {
    editCatalog: (_region, edit) => { calls.push(edit); return write.promise },
    refreshCatalog: async () => { calls.push('refresh'); return { ok: true, value: bothEnabled } },
  })
  void editor.edit(toggle('a', true))
  void editor.edit(toggle('b', true))
  assert.deepEqual(calls, [])
  const refreshing = editor.discover()
  assert.equal(editor.getSnapshot().refreshRequested, true)
  assert.equal(editor.getSnapshot().savingChanges, true)
  assert.deepEqual(calls, [batch(toggle('a', true), toggle('b', true))])
  write.resolve({ ok: true, value: bothEnabled })
  await refreshing
  assert.deepEqual(calls, [batch(toggle('a', true), toggle('b', true)), 'refresh'])
  assert.equal(editor.getSnapshot().hasPendingChanges, false)
})

test('a failed batch preserves a newer choice and never invokes a waiting refresh', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const first = deferred<QoderRpcResult<readonly QoderCatalogModel[]>>()
  const second = deferred<QoderRpcResult<readonly QoderCatalogModel[]>>()
  const calls: QoderCatalogEdit[] = []
  let refreshCalls = 0
  const editor = new QoderModelCatalogEditor('global', [missing, other], {
    editCatalog: (_region, edit) => {
      calls.push(edit)
      return calls.length === 1 ? first.promise : second.promise
    },
    refreshCatalog: async () => {
      refreshCalls++
      return { ok: true, value: [missing, other] }
    },
  })
  void editor.edit(toggle('a', true))
  void editor.edit(toggle('b', true))
  t.mock.timers.tick(2000)
  void editor.edit(toggle('a', false))
  void editor.edit(toggle('a', true))
  void editor.discover()
  first.resolve(saveFailure)
  await nextTurn()
  assert.deepEqual(calls, [batch(toggle('a', true), toggle('b', true)), batch(toggle('a', true))])
  const enabledA = { ...missing, enabled: true }
  assert.deepEqual(editor.getSnapshot().viewModels, [enabledA, other])
  assert.equal(editor.getSnapshot().refreshRequested, false)
  second.resolve({ ok: true, value: [enabledA, other] })
  await nextTurn()
  assert.equal(refreshCalls, 0)
  assert.equal(editor.getSnapshot().failure, 'saveFailed')
  assert.deepEqual(editor.getSnapshot().models, [enabledA, other])
})

test('a newer choice already satisfied by a successful save makes no extra write', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const pending = deferred<QoderRpcResult<readonly QoderCatalogModel[]>>()
  const calls: QoderCatalogEdit[] = []
  const editor = new QoderModelCatalogEditor('global', [missing], {
    editCatalog: (_region, edit) => { calls.push(edit); return pending.promise },
  })
  void editor.edit(toggle('a', true))
  t.mock.timers.tick(2000)
  void editor.edit(toggle('a', false))
  void editor.edit(toggle('a', true))
  pending.resolve({ ok: true, value: [bothEnabled[0]] })
  await nextTurn()
  t.mock.timers.tick(2000)
  await nextTurn()
  assert.deepEqual(calls, [batch(toggle('a', true))])
  assert.equal(editor.getSnapshot().hasPendingChanges, false)
})

test('an automatic refresh pauses a ready batch and revalidates its targets before resuming', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let notify!: (status: QoderCatalogStatus) => void
  const first = deferred<QoderRpcResult<readonly QoderCatalogModel[]>>()
  const calls: QoderCatalogEdit[] = []
  const editor = new QoderModelCatalogEditor('global', [missing, other], {
    subscribeCatalog: (_region, listener) => {
      notify = listener
      notify(ready)
      return () => {}
    },
    editCatalog: (_region, edit) => {
      calls.push(edit)
      return calls.length === 1 ? first.promise : Promise.resolve({ ok: true, value: [bothEnabled[1]] })
    },
  })
  editor.activate()
  void editor.edit(toggle('a', true))
  void editor.edit(toggle('b', true))
  t.mock.timers.tick(2000)
  notify({ ...ready, refreshing: true })
  first.resolve({ ok: false, error: { code: 'CATALOG_REFRESHING', message: 'Refreshing' } })
  await nextTurn()
  assert.deepEqual(calls, [batch(toggle('a', true), toggle('b', true))])
  assert.deepEqual(editor.getSnapshot().viewModels, bothEnabled)
  editor.replaceModels([other])
  notify(ready)
  await nextTurn()
  assert.deepEqual(calls, [batch(toggle('a', true), toggle('b', true)), batch(toggle('b', true))])
  assert.equal(editor.getSnapshot().hasPendingChanges, false)
  assert.equal(editor.getSnapshot().failure, 'saveFailed')
  editor.dispose()
})

test('unmount flushes a debounced batch immediately and releases the subscription when saved', async () => {
  const pending = deferred<QoderRpcResult<readonly QoderCatalogModel[]>>()
  const calls: QoderCatalogEdit[] = []
  let subscriptions = 0
  const editor = new QoderModelCatalogEditor('global', [missing, other], {
    subscribeCatalog: (_region, listener) => {
      subscriptions++
      listener(ready)
      return () => { subscriptions-- }
    },
    editCatalog: (_region, edit) => { calls.push(edit); return pending.promise },
  })
  editor.activate()
  void editor.edit(toggle('a', true))
  void editor.edit(toggle('b', true))
  assert.deepEqual(calls, [])
  editor.dispose()
  assert.deepEqual(calls, [batch(toggle('a', true), toggle('b', true))])
  assert.equal(subscriptions, 1)
  pending.resolve({ ok: true, value: bothEnabled })
  await nextTurn()
  assert.deepEqual(editor.getSnapshot().models, bothEnabled)
  assert.equal(subscriptions, 0)
})

test('disable, delete and context tier changes share one pending batch and roll back together', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const removing = { ...missing, enabled: true }
  const tiered = { ...other, enabled: true, contextTier: 'small', contextWindow: 50,
    contextOptions: { small: { tokenCount: 50 }, large: { tokenCount: 100 } } }
  const pending = deferred<QoderRpcResult<readonly QoderCatalogModel[]>>()
  const calls: QoderCatalogEdit[] = []
  const editor = new QoderModelCatalogEditor('global', [removing, tiered], {
    editCatalog: (_region, edit) => { calls.push(edit); return pending.promise },
  })
  void editor.edit(toggle('a', false))
  void editor.edit({ action: 'delete', id: 'a' })
  void editor.edit({ action: 'selectTier', id: 'b', tierKey: 'large' })
  void editor.edit(toggle('b', false))
  assert.deepEqual(editor.getSnapshot().viewModels, [{ ...tiered, enabled: false, contextTier: 'large', contextWindow: 100 }])
  assert.deepEqual(calls, [])
  t.mock.timers.tick(2000)
  assert.deepEqual(calls, [{ action: 'editBatch', changes: [
    { id: 'a', enabled: false, remove: true },
    { id: 'b', tierKey: 'large', enabled: false },
  ] }])
  pending.resolve(saveFailure)
  await nextTurn()
  assert.deepEqual(editor.getSnapshot().viewModels, [removing, tiered])
  assert.equal(editor.getSnapshot().failure, 'saveFailed')
})


for (const mirrorUpdated of [true, false]) {
  test(`a stale tier preserves a disable when detected by the ${mirrorUpdated ? 'client' : 'host'}`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const small = { id: 'a', name: 'A', contextTier: 'small', contextWindow: 200_000,
      contextOptions: { small: { tokenCount: 200_000 } } }
    const tiered = { ...small, contextOptions: { ...small.contextOptions, large: { tokenCount: 1_000_000 } } }
    const confirmed = { ...small, enabled: false }
    const calls: QoderCatalogEdit[] = []
    const editor = new QoderModelCatalogEditor('global', [tiered], {
      editCatalog: async (_region, edit) => {
        calls.push(edit)
        if (!mirrorUpdated && calls.length === 1) {
          return { ok: false, error: { code: 'CATALOG_TIER_UNAVAILABLE', message: 'Stale tier', details: { modelIds: ['a'] } } }
        }
        return { ok: true, value: [confirmed] }
      },
    })
    void editor.edit({ action: 'selectTier', id: 'a', tierKey: 'large' })
    void editor.edit(toggle('a', false))
    if (mirrorUpdated) {
      editor.replaceModels([small])
      assert.deepEqual(editor.getSnapshot().viewModels, [confirmed])
    }
    t.mock.timers.tick(2000)
    await nextTurn()
    assert.deepEqual(calls, [
      ...mirrorUpdated ? [] : [{ action: 'editBatch', changes: [{ id: 'a', tierKey: 'large', enabled: false }] }],
      batch(toggle('a', false)),
    ])
    assert.equal(editor.getSnapshot().failure, 'catalogTierNotSaved')
    assert.deepEqual(editor.getSnapshot().viewModels, [confirmed])
  })
}

test('contention retries the latest queued changes with a bounded backoff', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const calls: QoderCatalogEdit[] = []
  let busy = true
  const editor = new QoderModelCatalogEditor('global', [missing, other], {
    editCatalog: async (_region, edit) => {
      calls.push(edit)
      return busy
        ? { ok: false, error: { code: 'CATALOG_EDITING', message: 'Another writer is saving' } }
        : { ok: true, value: bothEnabled }
    },
  })
  void editor.edit(toggle('a', true))
  t.mock.timers.tick(2000)
  await nextTurn()
  void editor.edit(toggle('b', true))
  assert.deepEqual(editor.getSnapshot().viewModels, bothEnabled)
  t.mock.timers.tick(149)
  assert.equal(calls.length, 1)
  busy = false
  t.mock.timers.tick(1)
  await nextTurn()
  assert.deepEqual(calls, [batch(toggle('a', true)), batch(toggle('a', true), toggle('b', true))])
  assert.equal(editor.getSnapshot().failure, undefined)

  busy = true
  void editor.edit(toggle('a', false))
  t.mock.timers.tick(2000)
  await nextTurn()
  for (const delay of [150, 300, 600, 1200, 2400]) {
    t.mock.timers.tick(delay)
    await nextTurn()
  }
  assert.equal(calls.length, 8)
  assert.equal(editor.getSnapshot().hasPendingChanges, false)
  assert.equal(editor.getSnapshot().failure, 'saveFailed')
  assert.deepEqual(editor.getSnapshot().viewModels, bothEnabled)
})
