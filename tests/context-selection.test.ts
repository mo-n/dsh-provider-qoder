import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { historicalContextWindow, isQoderProvider, modelsOf, saveContextSelection } from '../src/client/context-selection.ts'
import { resolveContextTier, type QoderCatalogModel } from '../src/qoder/catalog.ts'
import { QODER_PROVIDER_ID } from '../src/dsh/provider.ts'
import type { QoderModelSettingsSnapshot } from '../src/client/credential-operations.ts'

const model: QoderCatalogModel = {
  id: 'a', name: 'A', contextTier: 'large', contextWindow: 1_000_000,
  contextOptions: { small: { tokenCount: 200_000, isDefault: true }, large: { tokenCount: 1_000_000 } },
}

test('returning from B after restart uses A default, not B capacity', () => {
  const current = { provider: QODER_PROVIDER_ID, model: 'a' }
  const history = { provider: QODER_PROVIDER_ID, model: 'b' }
  assert.equal(resolveContextTier(model, undefined, historicalContextWindow(current, history, 200_000))?.key, 'large')
  assert.equal(resolveContextTier(model, undefined, historicalContextWindow(current, current, 200_000))?.key, 'small')
  assert.equal(historicalContextWindow(current, { ...current, provider: 'other' }, 200_000), undefined)
  assert.equal(isQoderProvider('other'), false)
})

test('scoped catalogs never fall back to another region or repopulate an empty catalog', () => {
  const section = { modelsByRegion: { global: [model] } }
  assert.ok(!modelsOf(section, 'china', 'global').some(candidate => candidate.id === model.id))
  assert.deepEqual(modelsOf({ ...section, modelsByRegion: { china: [] } }, 'china', 'global'), [])
})

test('tier write failures preserve defaults and report partial success explicitly', async () => {
  let saved = 0
  let allowSession = false
  let allowDefaults = false
  const operations = {
    getModelSnapshot: () => ({ value: { modelsByRegion: { global: [model] } } }) as QoderModelSettingsSnapshot,
    setSessionTier: async () => allowSession,
    storeModels: async () => { saved++; return allowDefaults },
  }
  assert.equal(await saveContextSelection(operations, 's', 'global', 'a', 'small', 'global'), 'session-failed')
  assert.equal(saved, 0)
  allowSession = true
  assert.equal(await saveContextSelection(operations, 's', 'global', 'a', 'small', 'global'), 'default-failed')
  allowDefaults = true
  assert.equal(await saveContextSelection(operations, 's', 'global', 'a', 'small', 'global'), 'saved')
  operations.setSessionTier = async () => { throw new Error('offline') }
  assert.equal(await saveContextSelection(operations, 's', 'global', 'a', 'small', 'global'), 'session-failed')
  assert.equal(saved, 2)
})

test('default update reads fresh models after session acknowledgement', async () => {
  let snapshot = [model]
  const newcomer = { id: 'new', name: 'New' }
  let stored: QoderCatalogModel[] = []
  const result = await saveContextSelection({
    getModelSnapshot: () => ({ value: { modelsByRegion: { global: snapshot } } }) as QoderModelSettingsSnapshot,
    setSessionTier: async () => { snapshot = [...snapshot, newcomer]; return true },
    storeModels: async (_region, models) => { stored = models; return true },
  }, 's', 'global', 'a', 'small', 'global')
  assert.equal(result, 'saved')
  assert.equal(stored[0].contextTier, 'small')
  assert.equal(stored[1], newcomer)
})

test('composer keeps projection hook order stable across unresolved, foreign, single and multi-tier models', async () => {
  const filename = new URL('../src/client/QoderContextSelect.tsx', import.meta.url)
  const source = ts.transpileModule(await readFile(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText
  const require = createRequire(filename)
  const exports: Record<string, (props: object) => unknown> = {}
  // Public component render harness: hooks read snapshots synchronously; effects are not mounted.
  runInNewContext(source, {
    exports,
    require: (id: string) => id === 'react' ? {
      useState: (value: unknown) => [value, () => {}],
      useRef: (value: unknown) => ({ current: value }),
      useEffect: () => {},
      useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
    } : id.endsWith('.css') ? {} : require(id),
  })
  const single = { id: 'single', name: 'Single' }
  for (const current of [null, { provider: 'other', model: 'a' }, { provider: QODER_PROVIDER_ID, model: 'single' }, { provider: QODER_PROVIDER_ID, model: 'a' }]) {
    const hooks: string[] = []
    const output = exports.QoderContextSelect({
      sessionId: 's',
      directory: { getSnapshot: () => ({ current }), subscribe: () => () => {} },
      operations: {
        getModelSnapshot: () => ({ value: { modelsByRegion: { global: [model, single] } } }),
        subscribeModels: () => () => {},
      },
      useProjection: (key: string) => { hooks.push(key); return undefined },
    })
    assert.deepEqual(hooks, ['modelSelection', 'contextPressure'])
    assert.equal(output !== null, current?.provider === QODER_PROVIDER_ID && current.model === 'a')
  }
})
