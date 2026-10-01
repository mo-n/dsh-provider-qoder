import test from 'node:test'
import assert from 'node:assert/strict'
import { QoderModelCatalogEditor } from '../src/client/model-catalog-editor.ts'
import type { QoderCatalogModel } from '../src/qoder/catalog.ts'
import type { QoderModelDiscoveryResult } from '../src/client/credential-operations.ts'

const globalModels: QoderCatalogModel[] = [
  { id: 'global-a', name: 'Global A', contextTier: 'small', contextWindow: 200_000,
    contextOptions: { small: { tokenCount: 200_000, isDefault: true }, large: { tokenCount: 1_000_000 } } },
  { id: 'global-b', name: 'Global B' },
]
const chinaModels: QoderCatalogModel[] = [{ id: 'china-a', name: 'China A' }]
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test('region switch discards a late discovery without submitting a save', async () => {
  const result = deferred<QoderModelDiscoveryResult>()
  const writes: string[] = []
  const operations = { discoverModels: () => result.promise,
    storeModels: async (region: string) => { writes.push(region); return true } }
  const global = new QoderModelCatalogEditor('global', globalModels, operations)
  const pending = global.discover()
  assert.equal(global.getSnapshot().pending, 'discovering')
  global.dispose()
  const china = new QoderModelCatalogEditor('china', chinaModels, operations)
  result.resolve({ ok: true, value: globalModels })
  await pending
  assert.deepEqual(writes, [])
  assert.deepEqual(china.getSnapshot().catalog, chinaModels)
  assert.equal(china.getSnapshot().pending, undefined)
})

for (const accepted of [true, false]) {
  test(`submitted Global save finishes after switching region (${accepted ? 'accepted' : 'refused'})`, async () => {
    const result = deferred<boolean>()
    const writes: Array<{ region: string; models: QoderCatalogModel[] }> = []
    const operations = { discoverModels: async () => ({ ok: true as const, value: globalModels }),
      storeModels: async (region: string, models: QoderCatalogModel[]) => { writes.push({ region, models }); return result.promise } }
    const global = new QoderModelCatalogEditor('global', globalModels, operations)
    let notifications = 0
    global.subscribe(() => { notifications++ })
    const pending = global.selectTier('global-a', 'large')
    global.dispose()
    const china = new QoderModelCatalogEditor('china', chinaModels, operations)
    const chinaSnapshot = china.getSnapshot()
    // Returning to Global creates a fresh editor; old work must not alter it either.
    const returnedGlobal = new QoderModelCatalogEditor('global', globalModels, operations)
    result.resolve(accepted)
    await pending
    assert.equal(writes.length, 1)
    assert.equal(writes[0].region, 'global')
    assert.equal(writes[0].models[0].contextTier, 'large')
    assert.equal(china.getSnapshot(), chinaSnapshot)
    assert.equal(returnedGlobal.getSnapshot().pending, undefined)
    assert.equal(returnedGlobal.getSnapshot().failure, undefined)
    assert.equal(notifications, 1)
  })
}

test('saving locks further edits and discovery until settlement', async () => {
  const result = deferred<boolean>()
  let writes = 0
  let discoveries = 0
  const editor = new QoderModelCatalogEditor('global', globalModels, {
    discoverModels: async () => { discoveries++; return { ok: true, value: globalModels } },
    storeModels: async () => { writes++; return result.promise },
  })
  const pending = editor.toggle('global-b', false)
  assert.equal(editor.getSnapshot().pending, 'saving')
  await editor.toggle('global-a', false)
  await editor.selectTier('global-a', 'large')
  await editor.discover()
  assert.equal(writes, 1)
  assert.equal(discoveries, 0)
  result.resolve(true)
  await pending
  assert.equal(editor.getSnapshot().pending, undefined)
  assert.deepEqual(editor.getSnapshot().models.map(model => model.id), ['global-a'])
})

for (const throws of [false, true]) {
  test(`failed save restores selection and default Context Tier (${throws ? 'exception' : 'refusal'})`, async () => {
    let fail = false
    const editor = new QoderModelCatalogEditor('global', globalModels, {
      discoverModels: async () => ({ ok: true, value: [...globalModels, { id: 'new', name: 'New' }] }),
      storeModels: async () => {
        if (fail && throws) throw new Error('offline')
        return !fail
      },
    })
    await editor.discover()
    const confirmed = editor.getSnapshot().models
    fail = true
    await editor.selectTier('global-a', 'large')
    assert.deepEqual(editor.getSnapshot().models, confirmed)
    assert.deepEqual(editor.getSnapshot().catalog, confirmed)
    assert.equal(editor.getSnapshot().failure, 'saveFailed')
    fail = false
    await editor.selectTier('global-a', 'large')
    assert.equal(editor.getSnapshot().failure, undefined)
    assert.equal(editor.getSnapshot().models[0].contextTier, 'large')
  })
}

for (const outcome of ['accepted', 'refused', 'exception'] as const) {
  test(`${outcome} save preserves newer accepted settings and subsequent edits`, async () => {
    const result = deferred<boolean>()
    const writes: QoderCatalogModel[][] = []
    const editor = new QoderModelCatalogEditor('global', globalModels, {
      discoverModels: async () => ({ ok: true, value: globalModels }),
      storeModels: async (_region, models) => {
        writes.push(models)
        return writes.length === 1 ? result.promise : true
      },
    })
    const pending = editor.selectTier('global-a', 'large')
    const latest = [{ ...globalModels[0], name: 'Updated elsewhere' }, { id: 'new', name: 'New' }]
    editor.replaceModels(latest)
    if (outcome === 'exception') result.reject(new Error('offline'))
    else result.resolve(outcome === 'accepted')
    await pending
    assert.deepEqual(editor.getSnapshot().models, latest)
    assert.deepEqual(editor.getSnapshot().catalog.filter(model => latest.some(value => value.id === model.id)), latest)
    assert.equal(editor.getSnapshot().pending, undefined)
    assert.equal(editor.getSnapshot().failure, outcome === 'accepted' ? undefined : 'saveFailed')
    await editor.selectTier('global-a', 'large')
    assert.deepEqual(writes[1], [{ ...latest[0], contextTier: 'large', contextWindow: 1_000_000 }, latest[1]])
  })
}

test('discovery failures release the editor and removing the last model never saves', async () => {
  let fail = true
  let writes = 0
  const editor = new QoderModelCatalogEditor('china', chinaModels, {
    discoverModels: async () => {
      if (fail) throw new Error('offline')
      return { ok: false, error: { code: 'UPSTREAM_ERROR', message: 'Unavailable' } }
    },
    storeModels: async () => { writes++; return true },
  })
  await editor.discover()
  assert.equal(editor.getSnapshot().pending, undefined)
  assert.equal(editor.getSnapshot().failure, 'modelsFetchFailed')
  fail = false
  await editor.discover()
  assert.equal(editor.getSnapshot().failureMessage, 'Unavailable')
  await editor.toggle('china-a', false)
  assert.equal(writes, 0)
  assert.equal(editor.getSnapshot().failure, 'modelsRequired')
  assert.deepEqual(editor.getSnapshot().models, chinaModels)
})

test('directory follows accepted settings before discovery and after a failed save', async () => {
  const editor = new QoderModelCatalogEditor('global', globalModels, {
    discoverModels: async () => ({ ok: true, value: globalModels }), storeModels: async () => false,
  })
  const latest = [...globalModels, { id: 'new', name: 'New' }]
  editor.replaceModels(latest)
  assert.deepEqual(editor.getSnapshot().catalog, latest)
  await editor.selectTier('global-a', 'large')
  editor.replaceModels(globalModels)
  assert.deepEqual(editor.getSnapshot().catalog, globalModels)
})

test('discovery retains unselected entries when accepted settings arrive before acknowledgement', async () => {
  const result = deferred<boolean>()
  const discovered = [...globalModels, { id: 'new', name: 'New' }]
  const editor = new QoderModelCatalogEditor('global', globalModels, {
    discoverModels: async () => ({ ok: true, value: discovered }),
    storeModels: () => result.promise,
  })
  const pending = editor.discover()
  await Promise.resolve()
  assert.equal(editor.getSnapshot().pending, 'saving')
  editor.replaceModels([discovered[2]])
  result.resolve(true)
  await pending
  assert.deepEqual(editor.getSnapshot().models, [discovered[2]])
  assert.deepEqual(editor.getSnapshot().catalog, discovered)
  await editor.toggle('global-a', true)
  assert.deepEqual(editor.getSnapshot().models.map(model => model.id), ['global-a', 'new'])
})
