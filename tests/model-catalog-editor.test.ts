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

test('an edit already pending blocks further local edits and refresh', async () => {
  const pending = deferred<QoderRpcResult<readonly QoderCatalogModel[]>>()
  let calls = 0
  const editor = new QoderModelCatalogEditor('global', [missing], {
    editCatalog: () => { calls++; return pending.promise },
    refreshCatalog: () => { calls++; return pending.promise },
  })
  const editing = editor.edit({ action: 'delete', id: 'a' })
  await editor.edit({ action: 'toggle', id: 'a', enabled: true })
  await editor.discover()
  assert.equal(calls, 1)
  pending.resolve({ ok: true, value: [] })
  await editing
  assert.deepEqual(editor.getSnapshot().models, [])
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
  action: 'toggleBatch',
  toggles: items.map(({ id, enabled }) => ({ id, enabled })),
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
  assert.deepEqual([...editor.getSnapshot().pendingToggles], [['b', true]])
  assert.equal(editor.getSnapshot().savingToggles, false)
  t.mock.timers.tick(1999)
  assert.deepEqual(calls, [])
  t.mock.timers.tick(1)
  await nextTurn()
  assert.deepEqual(calls, [batch(toggle('b', true))])
  assert.equal(editor.getSnapshot().pendingToggles.size, 0)

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
  assert.equal(editor.getSnapshot().savingToggles, true)
  assert.deepEqual(calls, [batch(toggle('a', true), toggle('b', true))])
  write.resolve({ ok: true, value: bothEnabled })
  await refreshing
  assert.deepEqual(calls, [batch(toggle('a', true), toggle('b', true)), 'refresh'])
  assert.equal(editor.getSnapshot().pendingToggles.size, 0)
})

test('a failed batch rolls back its models, preserves newer choices and cancels a waiting refresh', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const first = deferred<QoderRpcResult<readonly QoderCatalogModel[]>>()
  const second = deferred<QoderRpcResult<readonly QoderCatalogModel[]>>()
  const calls: QoderCatalogEdit[] = []
  const editor = new QoderModelCatalogEditor('global', [missing, other], {
    editCatalog: (_region, edit) => {
      calls.push(edit)
      return calls.length === 1 ? first.promise : second.promise
    },
    refreshCatalog: async () => assert.fail('refresh must wait for a successful drain'),
  })
  void editor.edit(toggle('a', true))
  void editor.edit(toggle('b', true))
  t.mock.timers.tick(2000)
  void editor.edit(toggle('a', false))
  void editor.discover()
  first.resolve(saveFailure)
  await nextTurn()
  assert.deepEqual(calls, [batch(toggle('a', true), toggle('b', true)), batch(toggle('a', false))])
  assert.deepEqual([...editor.getSnapshot().pendingToggles], [['a', false]])
  assert.equal(editor.getSnapshot().refreshRequested, false)
  second.resolve({ ok: true, value: [missing, other] })
  await nextTurn()
  assert.equal(editor.getSnapshot().failure, 'saveFailed')
  assert.deepEqual(editor.getSnapshot().models, [missing, other])
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
  assert.equal(editor.getSnapshot().pendingToggles.size, 2)
  editor.replaceModels([other])
  notify(ready)
  await nextTurn()
  assert.deepEqual(calls, [batch(toggle('a', true), toggle('b', true)), batch(toggle('b', true))])
  assert.equal(editor.getSnapshot().pendingToggles.size, 0)
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
