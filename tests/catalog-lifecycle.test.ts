import test from 'node:test'
import assert from 'node:assert/strict'
import { SettingsConflictError, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { QoderCatalogLifecycle, type QoderCatalogSettings } from '../src/dsh/catalog-lifecycle.ts'
import { Config, modelsFor } from '../src/dsh/config.ts'
import type { QoderCatalogModel } from '../src/qoder/catalog.ts'
import type { QoderRegion } from '../src/qoder/region.ts'
import type { QoderTransport } from '../src/qoder/transport/index.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const advertised = (priceFactor: number): QoderCatalogModel[] => [{ id: 'chosen', name: 'Upstream', priceFactor }, { id: 'disabled', name: 'Disabled' }]
function transport(discoverModels: () => Promise<readonly QoderCatalogModel[]>): QoderTransport {
  return { discoverModels } as QoderTransport
}
async function drain() {
  for (let turn = 0; turn < 8; turn++) await new Promise<void>(resolve => setImmediate(resolve))
}
function runtime() {
  let active = transport(async () => advertised(1))
  let region: QoderRegion = 'global'
  let selected: readonly QoderCatalogModel[] = modelsFor(Config({ modelsByRegion: { global: [{ id: 'chosen', name: 'User name' }] } }), 'global')
  const errors: unknown[] = []
  const catalog = new QoderCatalogLifecycle({
    resolveTransport: () => active, region: () => region, configuredModels: () => selected,
    onPersistenceError: error => { errors.push(error) },
  })
  return { catalog, errors, setTransport(value: QoderTransport) { active = value; catalog.observeTransport() },
    setRegion(value: QoderRegion) { region = value; catalog.observeTransport() },
    setSelected(value: readonly QoderCatalogModel[]) { selected = value }, getSelected: () => selected }
}

test('later discovery wins even when older discovery finishes last', async () => {
  const { catalog, setTransport } = runtime()
  const old = deferred<readonly QoderCatalogModel[]>()
  const fresh = deferred<readonly QoderCatalogModel[]>()
  let calls = 0
  setTransport(transport(() => ++calls === 1 ? old.promise : fresh.promise))
  const automatic = catalog.refresh()
  await Promise.resolve()
  const explicit = catalog.discover()
  fresh.resolve(advertised(4))
  await explicit
  old.resolve(advertised(2))
  await automatic
  assert.equal(catalog.models()[0].priceFactor, 4)
  assert.deepEqual(catalog.models().map(model => model.id), ['chosen'])
})

test('failed newer discovery still supersedes older work and retains accepted metadata', async () => {
  const { catalog, setTransport } = runtime()
  await catalog.discover()
  const old = deferred<readonly QoderCatalogModel[]>()
  let calls = 0
  setTransport(transport(() => ++calls === 1 ? old.promise : Promise.reject(new Error('offline'))))
  const automatic = catalog.refresh()
  await Promise.resolve()
  await assert.rejects(catalog.discover(), /offline/)
  old.resolve(advertised(9))
  await automatic
  assert.equal(catalog.models()[0].priceFactor, 1)
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

test('explicit discovery returns fresh models without waiting for persistence', async () => {
  const { catalog, getSelected } = runtime()
  const gate = deferred<void>()
  let writes = 0
  catalog.bindSettings({ read: () => ({ models: getSelected(), revision: 0 }), write: async () => { writes++; await gate.promise } })
  assert.equal((await catalog.discover())[0].priceFactor, 1)
  assert.equal(catalog.models()[0].priceFactor, 1)
  await catalog.refresh()
  await drain()
  assert.equal(writes, 1)
  gate.resolve()
  await drain()
})

test('persistence serializes each region and coalesces intermediate discoveries', async () => {
  const { catalog, setTransport } = runtime()
  let price = 1
  setTransport(transport(async () => advertised(price)))
  let stored: readonly QoderCatalogModel[] = [{ id: 'chosen', name: 'User name' }]
  let revision = 0
  let activeWriters = 0
  let maxWriters = 0
  const prices: number[] = []
  const started = deferred<void>()
  const gate = deferred<void>()
  catalog.bindSettings({ read: () => ({ models: stored, revision }), write: async (_region, models, expected) => {
    assert.equal(expected, revision)
    maxWriters = Math.max(maxWriters, ++activeWriters)
    prices.push(models[0].priceFactor!)
    if (prices.length === 1) { started.resolve(); await gate.promise }
    stored = models
    revision++
    activeWriters--
  } })
  await catalog.discover()
  await started.promise
  price = 2
  await catalog.discover()
  price = 3
  await catalog.discover()
  assert.deepEqual(prices, [1])
  gate.resolve()
  await drain()
  assert.deepEqual(prices, [1, 3])
  assert.equal(maxWriters, 1)
  assert.equal(stored[0].name, 'User name')
  assert.deepEqual(stored.map(model => model.id), ['chosen'])
})

test('revision conflict retries against current selection and latest accepted discovery', async () => {
  const { catalog, setTransport } = runtime()
  let price = 1
  setTransport(transport(async () => advertised(price)))
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
  price = 4
  await catalog.discover()
  gate.resolve()
  await drain()
  assert.equal(writes, 2)
  assert.deepEqual(stored.map(model => model.id), ['chosen'])
  assert.equal(stored[0].name, 'User edited')
  assert.equal(stored[0].contextWindow, 50_000)
  assert.equal(stored[0].maxTokens, 2048)
  assert.equal(stored[0].priceFactor, 4)
})

for (const trigger of ['settings change', 'reattachment', 'successful discovery'] as const) {
  test(`persistence failure retains metadata and retries on ${trigger}`, async () => {
    const { catalog, errors } = runtime()
    let stored: readonly QoderCatalogModel[] = [{ id: 'chosen', name: 'User name' }]
    let fail = true
    let writes = 0
    const settings: QoderCatalogSettings = { read: () => ({ models: stored, revision: 0 }), write: async (_region, models) => {
      writes++
      if (fail) throw new Error('disk unavailable')
      stored = models
    } }
    catalog.bindSettings(settings)
    assert.equal((await catalog.discover())[0].priceFactor, 1)
    await drain()
    assert.equal(catalog.models()[0].priceFactor, 1)
    assert.equal(errors.length, 1)
    assert.equal(writes, 1)
    fail = false
    if (trigger === 'settings change') catalog.retryPersistence()
    else if (trigger === 'reattachment') { catalog.bindSettings(undefined); catalog.bindSettings(settings) }
    else await catalog.discover()
    await drain()
    assert.equal(writes, 2)
    assert.equal(stored[0].priceFactor, 1)
    // No redundant write after normalization, even when settings emits its own update.
    catalog.retryPersistence()
    await drain()
    assert.equal(writes, 2)
  })
}

test('late settings binding persists a previously accepted discovery', async () => {
  const { catalog } = runtime()
  await catalog.discover()
  let stored: readonly QoderCatalogModel[] = [{ id: 'chosen', name: 'Chosen' }]
  catalog.bindSettings({ read: () => ({ models: stored, revision: 0 }), write: async (_region, models) => { stored = models } })
  await drain()
  assert.equal(stored[0].priceFactor, 1)
})

test('replacement settings binding waits for the previous region writer', async () => {
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
  assert.equal(writes, 1)
})

test('disposed lifecycle never accepts or persists a late discovery', async () => {
  const { catalog, setTransport } = runtime()
  const pending = deferred<readonly QoderCatalogModel[]>()
  setTransport(transport(() => pending.promise))
  let writes = 0
  catalog.bindSettings({ read: () => ({ models: [{ id: 'chosen', name: 'Chosen' }], revision: 0 }), write: async () => { writes++ } })
  const discovering = catalog.discover()
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


test('a successful discovery during a failing write triggers the next persistence attempt', async () => {
  const { catalog, setTransport } = runtime()
  let price = 1
  setTransport(transport(async () => advertised(price)))
  const gate = deferred<void>()
  const started = deferred<void>()
  let writes = 0
  let stored: readonly QoderCatalogModel[] = [{ id: 'chosen', name: 'Chosen' }]
  catalog.bindSettings({ read: () => ({ models: stored, revision: 0 }), write: async (_region, models) => {
    if (++writes === 1) {
      started.resolve()
      await gate.promise
      throw new Error('Temporary failure')
    }
    stored = models
  } })
  await catalog.discover()
  await started.promise
  price = 4
  await catalog.discover()
  gate.resolve()
  await drain()
  assert.equal(writes, 2)
  assert.equal(stored[0].priceFactor, 4)
})
