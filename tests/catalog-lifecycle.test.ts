import test from 'node:test'
import { deferred } from './helpers/timing.ts'
import assert from 'node:assert/strict'
import { SettingsConflictError, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { QoderCatalogLifecycle } from '../src/dsh/catalog-lifecycle.ts'
import { Config, modelsFor } from '../src/dsh/config.ts'
import type { QoderCatalogModel } from '../src/qoder/catalog.ts'
import type { QoderRegion } from '../src/qoder/region.ts'
import type { QoderTransport } from '../src/qoder/transport/index.ts'

const advertised = (priceFactor: number): QoderCatalogModel[] => [{ id: 'chosen', name: 'Upstream', priceFactor }, { id: 'disabled', name: 'Disabled' }]
function transport(discoverModels: () => Promise<readonly QoderCatalogModel[]>): QoderTransport {
  return { discoverModels } as QoderTransport
}
async function drain() {
  for (let turn = 0; turn < 8; turn++) await new Promise<void>(resolve => setImmediate(resolve))
}
function runtime(options: { defaultBackoff?: boolean } = {}) {
  let active = transport(async () => advertised(1))
  let region: QoderRegion = 'global'
  let selected: readonly QoderCatalogModel[] = modelsFor(Config({ modelsByRegion: { global: [{ id: 'chosen', name: 'User name' }] } }), 'global')
  const errors: unknown[] = []
  const catalog = new QoderCatalogLifecycle({
    resolveTransport: () => active, region: () => region, configuredModels: () => selected,
    onPersistenceError: error => { errors.push(error) },
    persistenceConflictBackoffMs: options.defaultBackoff ? undefined : [0, 0, 0],
  })
  return { catalog, errors, setTransport(value: QoderTransport) { active = value; catalog.observeTransport() },
    setRegion(value: QoderRegion) { region = value; catalog.observeTransport() },
    setSelected(value: readonly QoderCatalogModel[]) { selected = value }, getSelected: () => selected }
}

test('a manual refresh shares upstream discovery and keeps the region locked until commit', async () => {
  const { catalog, setTransport, getSelected, setSelected } = runtime()
  const upstream = deferred<readonly QoderCatalogModel[]>()
  const saving = deferred<void>()
  const started = deferred<void>()
  let calls = 0
  setTransport(transport(() => { calls++; return upstream.promise }))
  catalog.bindSettings({ read: () => ({ models: getSelected(), revision: 0 }),
    write: async (_region, models) => { started.resolve(); await saving.promise; setSelected(models) } })
  const statuses: boolean[] = []
  const stop = catalog.subscribe(status => { if (status.region === 'global') statuses.push(status.refreshing) })
  const manual = catalog.refreshCatalog('global')
  const duplicate = catalog.refreshCatalog('global')
  const discovery = catalog.discover()
  upstream.resolve(advertised(4))
  await started.promise
  assert.equal(calls, 1)
  assert.equal((await discovery)[0].priceFactor, 4)
  assert.equal(catalog.status('global').refreshing, true)
  assert.equal(catalog.status('china').refreshing, false)
  await assert.rejects(catalog.editCatalog('global', { action: 'toggle', id: 'chosen', enabled: false }), /being updated/)
  saving.resolve()
  assert.deepEqual(await duplicate, await manual)
  assert.deepEqual(getSelected().map(model => model.id), ['chosen', 'disabled'])
  assert.deepEqual(statuses, [false, true, false])
  stop()
})

test('an automatic refresh rejects manual catalog edits and a concurrent manual refresh', async () => {
  const { catalog, setTransport } = runtime()
  const upstream = deferred<readonly QoderCatalogModel[]>()
  let calls = 0
  setTransport(transport(() => { calls++; return upstream.promise }))
  const automatic = catalog.refresh()
  await assert.rejects(catalog.refreshCatalog('global'), /being updated/)
  await assert.rejects(catalog.editCatalog('global', { action: 'delete', id: 'chosen' }), /being updated/)
  upstream.resolve(advertised(1))
  await automatic
  assert.equal(calls, 1)
  assert.deepEqual(catalog.models().map(model => model.id), ['chosen'])
})

test('switching away and back invalidates discovery even if a transport is reused', async () => {
  const { catalog, setTransport, setRegion } = runtime()
  const old = deferred<readonly QoderCatalogModel[]>()
  setTransport(transport(() => old.promise))
  const writes: string[] = []
  catalog.bindSettings({ read: () => ({ models: [{ id: 'chosen', name: 'Chosen' }], revision: 0 }),
    write: async region => { writes.push(region) } })
  const pending = catalog.discover()
  await Promise.resolve()
  setRegion('china')
  setRegion('global')
  old.resolve(advertised(9))
  await pending
  await drain()
  assert.equal(catalog.models()[0].priceFactor, undefined)
  assert.deepEqual(writes, [])
})

test('an authorization change rolls back an outdated commit before the new refresh', async () => {
  const { catalog, setTransport, getSelected, setSelected } = runtime()
  const previous = getSelected()
  const available = previous[0]
  const wrongSubscriberModel = { id: 'old-account-only', name: 'Old account model' }
  const saving = deferred<void>()
  const release = deferred<void>()
  const reverting = deferred<void>()
  const releaseRevert = deferred<void>()
  let revision = 0
  setTransport(transport(async () => [wrongSubscriberModel]))
  catalog.bindSettings({
    read: () => ({ models: getSelected(), revision }),
    write: async (_region, models, expected) => {
      assert.equal(expected, revision)
      if (!revision) { saving.resolve(); await release.promise }
      if (revision === 1) { reverting.resolve(); await releaseRevert.promise }
      setSelected(models)
      revision++
    },
  })

  const stale = assert.rejects(catalog.refreshCatalog('global'), { code: 'ABORTED' })
  await saving.promise
  catalog.clearDiscovered()
  setTransport(transport(async () => [available]))
  const reading = catalog.refresh()
  release.resolve()
  await reverting.promise
  const projected = catalog.models()
  const stillLocked = catalog.status('global').refreshing
  releaseRevert.resolve()
  await Promise.all([stale, reading])
  assert.ok(stillLocked)
  assert.deepEqual(projected, previous)
  assert.deepEqual(getSelected(), previous)
  assert.equal(revision, 2, 'the stale commit is compensated before the new catalog is accepted')
})

test('a cached read returns while a superseded write settles and revalidates afterwards', async () => {
  const { catalog, setTransport, getSelected, setSelected } = runtime()
  const available = getSelected()[0]
  let remote = [available]
  setTransport(transport(async () => remote))
  const saving = deferred<void>()
  const release = deferred<void>()
  let writes = 0
  catalog.bindSettings({
    read: () => ({ models: getSelected(), revision: writes }),
    write: async (_region, models) => {
      if (!writes++) { saving.resolve(); await release.promise }
      setSelected(models)
    },
  })
  await catalog.refresh()
  remote = [{ ...available, priceFactor: 2 }]
  const stale = assert.rejects(catalog.refreshCatalog('global'), { code: 'ABORTED' })
  await saving.promise
  setTransport(transport(async () => [{ ...available, priceFactor: 3 }]))
  const read = Promise.race([
    catalog.refresh().then(() => true),
    new Promise<false>(resolve => setImmediate(() => resolve(false))),
  ])
  const returnedBeforeSave = await read
  release.resolve()
  await stale
  await drain()
  assert.equal(returnedBeforeSave, true)
  assert.equal(catalog.models()[0].priceFactor, 3)
})

test('manual discovery preserves a deletion made through another entry point after the request begins', async () => {
  const { catalog, setTransport, getSelected, setSelected } = runtime()
  const existing = { id: 'chosen', name: 'Chosen', enabled: false, missingFromCatalog: true }
  const fresh = { id: 'new', name: 'New' }
  setSelected([existing])
  const upstream = deferred<readonly QoderCatalogModel[]>()
  setTransport(transport(() => upstream.promise))
  let revision = 0
  catalog.bindSettings({
    read: () => ({ models: getSelected(), revision }),
    write: async (_region, models, expected) => { assert.equal(expected, revision++); setSelected(models) },
  })
  const pending = catalog.refreshCatalog('global')
  setSelected([])
  revision++
  upstream.resolve([existing, fresh])
  assert.deepEqual((await pending).map(model => model.id), ['new'])
  assert.deepEqual(getSelected().map(model => model.id), ['new'])
})

test('missing models retain their tier and manual enablement until they return and disappear again', async () => {
  const { catalog, setTransport, getSelected, setSelected } = runtime()
  const missing = { id: 'chosen', name: 'Chosen', contextTier: 'large', contextWindow: 1_000_000 }
  const other = { id: 'other', name: 'Other' }
  setSelected([missing])
  let remote = [other]
  let revision = 0
  setTransport(transport(async () => remote))
  catalog.bindSettings({
    read: () => ({ models: getSelected(), revision }),
    write: async (_region, models, expected) => { assert.equal(expected, revision++); setSelected(models) },
  })
  const automatic = async () => { await catalog.discover(); await drain() }
  await automatic()
  assert.equal(getSelected()[0].contextTier, missing.contextTier)
  assert.equal(getSelected()[0].contextWindow, missing.contextWindow)
  assert.equal(getSelected()[0].enabled, false)
  assert.equal(getSelected()[0].missingFromCatalog, true)
  await catalog.editCatalog('global', { action: 'toggle', id: missing.id, enabled: true })
  catalog.clearDiscovered()
  await automatic()
  assert.equal(getSelected()[0].enabled, true)
  assert.equal(getSelected()[0].missingFromCatalog, true)
  remote = [other, missing]
  await automatic()
  assert.equal(getSelected()[0].enabled, true)
  assert.equal(getSelected()[0].missingFromCatalog, undefined)
  remote = [other]
  await automatic()
  assert.equal(getSelected()[0].enabled, false)
  const cleared = await catalog.editCatalog('global', { action: 'delete', id: missing.id })
  assert.deepEqual(cleared, [])
  remote = [other, missing]
  await automatic()
  assert.deepEqual(getSelected(), [])
  const manuallyFound = await catalog.refreshCatalog('global')
  assert.deepEqual(manuallyFound.map(model => model.id), [other.id, missing.id])
  assert.ok(manuallyFound.every(model => model.enabled !== false))
})

test('revision conflict rebases the discovery on the latest saved catalog', async () => {
  const { catalog, setTransport } = runtime()
  setTransport(transport(async () => advertised(1)))
  let stored: readonly QoderCatalogModel[] = [{ id: 'chosen', name: 'Before' }, { id: 'removed', name: 'Removed' }]
  let revision = 0
  const gate = deferred<void>()
  const started = deferred<void>()
  let writes = 0
  catalog.bindSettings({ read: () => ({ models: stored, revision }), write: async (_region, models, expected) => {
    if (++writes === 1) { started.resolve(); await gate.promise }
    if (expected !== revision) throw new SettingsConflictError('provider-qoder' as SettingsNamespace, expected, revision)
    stored = models
    revision++
  } })
  await catalog.discover()
  await started.promise
  stored = [{ id: 'chosen', name: 'User edited', contextWindow: 50_000, maxTokens: 2048 }]
  revision++
  gate.resolve()
  await drain()
  assert.equal(writes, 2)
  assert.deepEqual(stored.map(model => model.id), ['chosen'])
  assert.equal(stored[0].name, 'User edited')
  assert.equal(stored[0].contextWindow, 50_000)
  assert.equal(stored[0].maxTokens, 2048)
  assert.equal(stored[0].priceFactor, 1)
})

test('revision conflicts stop after a bounded retry budget and await explicit retry', async () => {
  const { catalog, errors } = runtime()
  let stored: readonly QoderCatalogModel[] = [{ id: 'chosen', name: 'Chosen' }]
  let conflicting = true
  let writes = 0
  const started = deferred<void>()
  catalog.bindSettings({
    read: () => ({ models: stored, revision: 0 }),
    write: async (_region, models, expected) => {
      writes++
      if (writes === 1) started.resolve()
      if (conflicting) throw new SettingsConflictError('provider-qoder' as SettingsNamespace, expected, expected + 1)
      stored = models
    },
  })

  await catalog.discover()
  await started.promise
  // A watcher notification during a conflict must not restart another
  // unbounded conflict cycle after the retry budget is exhausted.
  catalog.retryPersistence()
  await drain()
  assert.equal(writes, 4, 'one initial write plus three bounded conflict retries')
  assert.equal(errors.length, 1)
  assert.ok(errors[0] instanceof SettingsConflictError)

  // Exhaustion leaves metadata dirty but does not start another write by itself.
  await drain()
  assert.equal(writes, 4)

  conflicting = false
  await catalog.refreshCatalog('global')
  assert.equal(writes, 5)
  assert.equal(stored[0].priceFactor, 1)
})

test('revision conflicts use the default 50, 100 and 200ms backoff', async t => {
  const time = t.mock.timers
  time.enable({ apis: ['setTimeout'] })
  const { catalog, errors } = runtime({ defaultBackoff: true })
  let writes = 0
  const started = deferred<void>()
  catalog.bindSettings({
    read: () => ({ models: [{ id: 'chosen', name: 'Chosen' }], revision: 0 }),
    write: async (_region, _models, expected) => {
      writes++
      if (writes === 1) started.resolve()
      throw new SettingsConflictError('provider-qoder' as SettingsNamespace, expected, expected + 1)
    },
  })

  await catalog.discover()
  await started.promise
  await Promise.resolve()
  time.tick(49)
  await drain()
  assert.equal(writes, 1)
  time.tick(1)
  await drain()
  assert.equal(writes, 2)
  time.tick(99)
  await drain()
  assert.equal(writes, 2)
  time.tick(1)
  await drain()
  assert.equal(writes, 3)
  time.tick(199)
  await drain()
  assert.equal(writes, 3)
  time.tick(1)
  await drain()
  assert.equal(writes, 4)
  assert.equal(errors.length, 1)
})

test('replacing settings during conflict backoff does not write the old binding again', async t => {
  const time = t.mock.timers
  time.enable({ apis: ['setTimeout'] })
  const { catalog } = runtime({ defaultBackoff: true })
  let oldWrites = 0
  let newWrites = 0
  const started = deferred<void>()
  catalog.bindSettings({
    read: () => ({ models: [{ id: 'chosen', name: 'Chosen' }], revision: 0 }),
    write: async (_region, _models, expected) => {
      oldWrites++
      started.resolve()
      throw new SettingsConflictError('provider-qoder' as SettingsNamespace, expected, expected + 1)
    },
  })
  await catalog.discover()
  await started.promise
  await Promise.resolve()

  catalog.bindSettings({
    read: () => ({ models: [{ id: 'chosen', name: 'Replacement' }], revision: 0 }),
    write: async () => { newWrites++ },
  })
  time.tick(50)
  await drain()
  assert.equal(oldWrites, 1)
  assert.equal(newWrites, 1)
})

test('save failure keeps the accepted catalog and a new manual refresh can recover', async () => {
  const { catalog, errors, getSelected, setSelected } = runtime()
  let fail = true
  catalog.bindSettings({
    read: () => ({ models: getSelected(), revision: 0 }),
    write: async (_region, models) => {
      if (fail) throw new Error('disk unavailable')
      setSelected(models)
    },
  })
  await assert.rejects(catalog.refreshCatalog('global'), { code: 'CATALOG_SAVE_FAILED' })
  assert.equal(catalog.status('global').failure, 'save')
  assert.equal(catalog.status('global').refreshing, false)
  assert.equal(catalog.models()[0].priceFactor, undefined)
  assert.equal(errors.length, 1)
  fail = false
  await catalog.refreshCatalog('global')
  assert.equal(getSelected()[0].priceFactor, 1)
  assert.equal(catalog.status('global').failure, undefined)
})

test('late settings binding persists a previously accepted discovery', async () => {
  const { catalog } = runtime()
  await catalog.discover()
  let stored: readonly QoderCatalogModel[] = [{ id: 'chosen', name: 'Chosen' }]
  catalog.bindSettings({ read: () => ({ models: stored, revision: 0 }), write: async (_region, models) => { stored = models } })
  await drain()
  assert.equal(stored[0].priceFactor, 1)
})

test('an in-flight save does not write into a replacement settings binding', async () => {
  const { catalog } = runtime()
  const started = deferred<void>()
  const gate = deferred<void>()
  let writes = 0
  catalog.bindSettings({ read: () => ({ models: [{ id: 'chosen', name: 'Chosen' }], revision: 0 }),
    write: async () => { started.resolve(); await gate.promise } })
  await catalog.discover()
  await started.promise
  catalog.bindSettings({ read: () => ({ models: [{ id: 'chosen', name: 'Chosen' }], revision: 0 }),
    write: async () => { writes++ } })
  await drain()
  assert.equal(writes, 0)
  gate.resolve()
  await drain()
  assert.equal(writes, 0)
})

test('disposed lifecycle never accepts or persists a late discovery', async () => {
  const { catalog, setTransport } = runtime()
  const pending = deferred<readonly QoderCatalogModel[]>()
  setTransport(transport(() => pending.promise))
  let writes = 0
  catalog.bindSettings({ read: () => ({ models: [{ id: 'chosen', name: 'Chosen' }], revision: 0 }), write: async () => { writes++ } })
  const discovering = catalog.discover()
  await Promise.resolve()
  catalog.dispose()
  pending.resolve(advertised(9))
  await discovering
  await drain()
  assert.equal(catalog.models()[0].priceFactor, undefined)
  assert.equal(writes, 0)
})


test('pre-aborted or disposed discovery never calls upstream', async () => {
  const { catalog, setTransport } = runtime()
  let calls = 0
  setTransport(transport(async () => { calls++; return advertised(1) }))
  await assert.rejects(catalog.discover(AbortSignal.abort()), { code: 'ABORTED' })
  catalog.dispose()
  await assert.rejects(catalog.discover(), { code: 'ABORTED' })
  assert.equal(calls, 0)
})


test('an empty discovery leaves the configured catalog intact', async () => {
  const { catalog, setTransport, getSelected } = runtime()
  setTransport(transport(async () => []))
  const original = getSelected()
  catalog.bindSettings({ read: () => ({ models: getSelected(), revision: 0 }),
    write: async () => assert.fail('empty discovery must never write') })
  await assert.rejects(catalog.refreshCatalog('global'), { code: 'EMPTY_RESPONSE' })
  assert.equal(catalog.status('global').failure, 'fetch')
  assert.equal(catalog.status('global').refreshing, false)
  assert.deepEqual(catalog.models(), original)
})
