import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { isQoderProvider } from '../src/client/context-selection.ts'
import { resolveContextTier, type QoderCatalogModel } from '../src/qoder/catalog.ts'
import { QODER_PROVIDER_ID } from '../src/dsh/provider.ts'
import { QoderAdapter } from '../src/dsh/adapter.ts'
import type { QoderTransport } from '../src/qoder/transport/index.ts'
import { modelsOf, regionOf } from '../src/client/credential-operations.ts'

const model: QoderCatalogModel = {
  id: 'a', name: 'A', contextTier: 'large', contextWindow: 1_000_000,
  contextOptions: { small: { tokenCount: 200_000, isDefault: true }, large: { tokenCount: 1_000_000 } },
}

test('scoped catalogs never fall back to another region or repopulate an empty catalog', () => {
  const section = { modelsByRegion: { global: [model] } }
  assert.equal(regionOf({ region: 'china' }), 'china')
  assert.equal(regionOf({ region: 'unknown' }), 'global')
  assert.ok(!modelsOf(section, 'china').some(candidate => candidate.id === model.id))
  assert.deepEqual(modelsOf({ ...section, modelsByRegion: { china: [] } }, 'china'), [])
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
      useProjection: (key: string) => {
        hooks.push(key)
        // A new conversation has no saved selection; the directory supplies its default.
        return key === 'modelSelection' ? { next: null, lastUsed: null } : undefined
      },
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
      useState: (value: unknown) => [typeof value === 'function' ? value() : value, () => {}],
      useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
      useRef: (value: unknown) => ({ current: value }),
      useLayoutEffect: () => {},
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
  const keyed = exports.QoderModelCatalog({
    region: 'global',
    operations: {
      discoverModels: async () => ({ ok: true, value: [] }),
      storeModels: async (region: string, models: QoderCatalogModel[]) => {
        assert.equal(region, 'global')
        changedModels = models
        return true
      },
    },
    models: [tieredModel, singleModel],
    disabled: false,
    t: (key: string, values?: Record<string, string | number>) => key === 'modelRate' ? `${values?.value}x` : key,
  }) as VNode

  assert.equal((keyed as VNode & { key: string }).key, 'global')
  const vdom = (keyed.type as (props: object) => VNode)(keyed.props)
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

  // Selecting a new tier saves the updated model to its mounted region
  const selectHandler = tierSelect.props.onChange as (event: { currentTarget: { value: string } }) => void
  selectHandler({ currentTarget: { value: 'large' } })
  assert.equal(changedModels.length, 2)
  assert.equal(changedModels[0].id, 'tiered')
  assert.equal(changedModels[0].contextTier, 'large')
  assert.equal(changedModels[0].contextWindow, 1_000_000)
  assert.equal(changedModels[1].id, 'single')
})

test('composer renders the host-confirmed tier after remount and keys controls by region, session and model', async () => {
  const filename = new URL('../src/client/QoderContextSelect.tsx', import.meta.url)
  const require = createRequire(filename)
  const source = ts.transpileModule(await readFile(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText
  interface Cell { value?: unknown; deps?: readonly unknown[]; cleanup?: () => void }
  let cells: Cell[] = [], cursor = 0
  const effects: Array<{ cell: Cell; create: () => void | (() => void) }> = []
  const subscriptions = new Map<unknown, () => void>()
  const next = () => cells[cursor++] ?? (cells[cursor - 1] = {})
  const same = (a: readonly unknown[] | undefined, b: readonly unknown[]) => a?.length === b.length && b.every((v, i) => Object.is(v, a[i]))
  const effect = (create: () => void | (() => void), deps: readonly unknown[]) => {
    const cell = next()
    if (!same(cell.deps, deps)) { cell.deps = deps; effects.push({ cell, create }) }
  }
  const exports: Record<string, (props: object) => VNode | null> = {}
  interface VNode { type: unknown; key?: string; props: { children?: unknown; [key: string]: unknown } }
  const nodes = (value: unknown): VNode[] => Array.isArray(value) ? value.flatMap(nodes)
    : value && typeof value === 'object' && 'props' in value ? [value as VNode, ...nodes((value as VNode).props.children)] : []
  runInNewContext(source, { exports, require: (id: string) => id === 'react' ? {
    useState(initial: unknown) { const cell = next(); if (!('value' in cell)) cell.value = initial; return [cell.value, (value: unknown) => { cell.value = typeof value === 'function' ? value(cell.value) : value }] },
    useRef(initial: unknown) { const cell = next(); return cell.value ?? (cell.value = { current: initial }) },
    useMemo(create: () => unknown, deps: readonly unknown[]) { const cell = next(); if (!same(cell.deps, deps)) { cell.deps = deps; cell.value = create() }; return cell.value },
    useEffect: effect, useLayoutEffect: effect,
    useSyncExternalStore(subscribe: (fn: () => void) => () => void, read: () => unknown) {
      if (!subscriptions.has(subscribe)) subscriptions.set(subscribe, subscribe(() => {}))
      return read()
    },
  } : id.endsWith('.css') ? { __esModule: true, default: {} } : require(id) })
  const adapter = new QoderAdapter({ models: [model], resolveTransport: () => ({}) as QoderTransport })
  adapter.setSessionTier('s', 'a', 'small')
  let settings = { value: { region: 'global', modelsByRegion: { global: [model], china: [model] } } }
  const props = {
    sessionId: 's', directory: { getSnapshot: () => ({ current: { provider: QODER_PROVIDER_ID, model: 'a' } }), subscribe: () => () => {} },
    operations: {
      getModelSnapshot: () => settings, subscribeModels: () => () => {},
      readSessionTier: async (scope: { region: 'global'; sessionId: string; modelId: string }) => adapter.readSessionTier(scope),
    },
  }
  const unmount = () => { for (const cell of cells) cell.cleanup?.(); for (const off of subscriptions.values()) off(); subscriptions.clear(); cells = [] }
  const render = () => {
    cursor = 0
    const outer = exports.QoderContextSelect(props)!
    const tree = (outer.type as (props: object) => VNode)(outer.props)
    for (const { cell, create } of effects.splice(0)) { cell.cleanup?.(); cell.cleanup = create() || undefined }
    return { outer, trigger: nodes(tree).find(node => node.props['aria-expanded'] !== undefined)! }
  }
  try {
    const first = render()
    assert.equal(first.trigger.props.disabled, true)
    assert.equal(first.trigger.props.title, '选择上下文大小: …')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(render().trigger.props.title, '选择上下文大小: 200K')
    unmount()
    assert.equal(render().trigger.props.title, '选择上下文大小: …')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(render().trigger.props.title, '选择上下文大小: 200K')
    assert.equal(render().outer.key, JSON.stringify(['global', 's', 'a']))
    props.sessionId = 'other'
    assert.equal(exports.QoderContextSelect(props)!.key, JSON.stringify(['global', 'other', 'a']))
    settings = { ...settings, value: { ...settings.value, region: 'china' } }
    assert.equal(exports.QoderContextSelect(props)!.key, JSON.stringify(['china', 'other', 'a']))
  } finally { unmount() }
})
