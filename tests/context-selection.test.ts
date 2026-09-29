import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { historicalContextWindow, isQoderProvider, saveContextSelection } from '../src/client/context-selection.ts'
import { resolveContextTier, type QoderCatalogModel } from '../src/qoder/catalog.ts'
import { QODER_PROVIDER_ID } from '../src/dsh/provider.ts'
import { modelsOf, regionOf, type QoderModelSettingsSnapshot } from '../src/client/credential-operations.ts'

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
  assert.equal(regionOf({ region: 'china' }), 'china')
  assert.equal(regionOf({ region: 'unknown' }), 'global')
  assert.ok(!modelsOf(section, 'china').some(candidate => candidate.id === model.id))
  assert.deepEqual(modelsOf({ ...section, modelsByRegion: { china: [] } }, 'china'), [])
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
  assert.equal(await saveContextSelection(operations, 's', 'global', 'a', 'small'), 'session-failed')
  assert.equal(saved, 0)
  allowSession = true
  assert.equal(await saveContextSelection(operations, 's', 'global', 'a', 'small'), 'default-failed')
  allowDefaults = true
  assert.equal(await saveContextSelection(operations, 's', 'global', 'a', 'small'), 'saved')
  operations.setSessionTier = async () => { throw new Error('offline') }
  assert.equal(await saveContextSelection(operations, 's', 'global', 'a', 'small'), 'session-failed')
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
  }, 's', 'global', 'a', 'small')
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

test('model catalog renders context tier select and propagates default tier changes', async () => {
  const filename = new URL('../src/client/QoderModelCatalog.tsx', import.meta.url)
  const source = ts.transpileModule(await readFile(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText
  const require = createRequire(filename)
  const exports: Record<string, (props: object) => unknown> = {}
  runInNewContext(source, {
    exports,
    require: (id: string) => id === 'react' ? {
      useMemo: (fn: () => unknown) => fn(),
      useState: (value: unknown) => [value, () => {}],
      useRef: (value: unknown) => ({ current: value }),
      useEffect: () => {},
    } : id.endsWith('.css') ? { __esModule: true, default: new Proxy({}, { get: (_, prop) => String(prop) }) } : require(id),
  })

  const tieredModel: QoderCatalogModel = {
    id: 'tiered', name: 'Tiered', contextWindow: 200_000,
    contextOptions: {
      small: { tokenCount: 200_000, isDefault: true },
      large: { tokenCount: 1_000_000 },
    },
  }
  const singleModel: QoderCatalogModel = {
    id: 'single', name: 'Single', contextWindow: 100_000,
  }

  let changedModels: QoderCatalogModel[] = []
  type VNode = { type: unknown; props: Record<string, unknown> }
  const vdom = exports.QoderModelCatalog({
    operations: { discoverModels: async () => ({ ok: true, value: [] }) },
    models: [tieredModel, singleModel],
    disabled: false,
    onChange: (models: QoderCatalogModel[]) => { changedModels = models },
    t: (key: string, values?: Record<string, string | number>) => key === 'modelRate' ? `${values?.value}x` : key,
  }) as VNode

  const children = vdom.props.children as VNode[]
  const modelList = children.find(c => c && typeof c.props?.className === 'string' && c.props.className.includes('modelList'))
  assert.ok(modelList)
  const choices = modelList.props.children as VNode[]
  assert.equal(choices.length, 2)

  // Tiered model has modelTier select
  const tieredChoice = choices[0].props.children as (VNode | null)[]
  const tierSection = tieredChoice.find(c => c && typeof c.props?.className === 'string' && c.props.className.includes('modelTier'))
  assert.ok(tierSection)
  const tierSelect = (tierSection.props.children as VNode[]).find(c => c.type === 'select')
  assert.ok(tierSelect)
  assert.equal(tierSelect.props.value, 'small')

  // Single model has no tier select
  const singleChoice = choices[1].props.children as (VNode | null)[]
  const singleTierSection = singleChoice.find(c => c && typeof c.props?.className === 'string' && c.props.className.includes('modelTier'))
  assert.equal(singleTierSection, undefined)

  // Selecting a new tier triggers onChange with updated model
  const selectHandler = tierSelect.props.onChange as (event: { currentTarget: { value: string } }) => void
  selectHandler({ currentTarget: { value: 'large' } })
  assert.equal(changedModels.length, 2)
  assert.equal(changedModels[0].id, 'tiered')
  assert.equal(changedModels[0].contextTier, 'large')
  assert.equal(changedModels[0].contextWindow, 1_000_000)
  assert.equal(changedModels[1].id, 'single')
})
