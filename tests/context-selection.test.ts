import { success } from './helpers/operation-result.ts'
import { deferred, nextTurn } from './helpers/timing.ts'
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

test('model catalog separates row actions and details and reflects pending toggles', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const labelFile = new URL('../src/client/QoderModelLabel.tsx', import.meta.url)
  const filename = new URL('../src/client/QoderModelCatalog.tsx', import.meta.url)
  const compile = async (file: URL) => ts.transpileModule(await readFile(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText
  const require = createRequire(filename)
  const exports: Record<string, (props: object) => unknown> = {}
  const labelExports: Record<string, unknown> = {}
  const states: unknown[] = []
  let cursor = 0
  let stopFeedback: (() => void) | undefined
  t.after(() => stopFeedback?.())
  const context = {
    setTimeout,
    clearTimeout,
    require: (id: string) => id === 'react' ? {
      useMemo: (fn: () => unknown) => fn(),
      useState: (value: unknown) => {
        const index = cursor++
        if (!(index in states)) states[index] = typeof value === 'function' ? value() : value
        return [states[index], (next: unknown) => { states[index] = next }]
      },
      useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
      useRef: (value: unknown) => ({ current: value }),
      useEffect: (effect: () => () => void) => { stopFeedback ??= effect() },
      useLayoutEffect: (effect: () => unknown) => { effect() },
    } : id === '@deepseek-ai/dsh-client-ui-primitives' ? { Menu: 'menu', IconChevronDownOutlineRegular: 'svg', Tag: 'tag' }
      : id === './QoderModelLabel.tsx' ? labelExports
      : id.endsWith('.css') ? { __esModule: true, default: new Proxy({}, { get: (_, prop) => String(prop) }) } : require(id),
  }
  runInNewContext(await compile(labelFile), { ...context, exports: labelExports })
  runInNewContext(await compile(filename), { ...context, exports })

  const tieredModel: QoderCatalogModel = {
    id: 'tiered', name: 'Tiered', contextWindow: 200_000, priceFactor: 0.5, originalPriceFactor: 1,
    contextOptions: {
      small: { tokenCount: 200_000, isDefault: true },
      large: { tokenCount: 1_000_000 },
    },
  }
  const singleModel: QoderCatalogModel = {
    id: 'single', name: 'Single', contextWindow: 100_000, missingFromCatalog: true, enabled: false,
  }

  let changedModels: QoderCatalogModel[] = []
  const toggle = deferred<void>()
  let toggleCalls = 0
  let reportStatus!: (status: object) => void
  type VNode = { type: unknown; props: Record<string, unknown> }
  const keyed = exports.QoderModelCatalog({
    region: 'global',
    operations: {
      subscribeCatalog: (region: string, listener: (status: object) => void) => {
        reportStatus = listener
        listener({ region, refreshing: false })
        return () => {}
      },
      editCatalog: async (region: string, edit: { action: string }) => {
        assert.equal(region, 'global')
        if (edit.action === 'toggleBatch') {
          assert.equal(JSON.stringify(edit), JSON.stringify({ action: 'toggleBatch', toggles: [{ id: 'single', enabled: true }] }))
          toggleCalls++
          await toggle.promise
          return { ok: false, error: { code: 'INTERNAL', message: 'Save failed' } }
        }
        assert.equal(JSON.stringify(edit), JSON.stringify({ action: 'selectTier', id: 'tiered', tierKey: 'large' }))
        changedModels = [{ ...tieredModel, contextTier: 'large', contextWindow: 1_000_000 }, singleModel]
        return success(changedModels)
      },
    },
    models: [tieredModel, singleModel],
    disabled: false,
    t: (key: string) => key,
  }) as VNode

  assert.equal((keyed as VNode & { key: string }).key, 'global')
  const render = keyed.type as (props: object) => VNode
  render(keyed.props)
  const childrenOf = (parent: VNode) => [parent.props.children].flat() as (VNode | null)[]
  const find = (parent: VNode, className: string) => childrenOf(parent).find(node => node?.props?.className === className)
  const rows = () => {
    cursor = 0
    const list = find(render(keyed.props), 'modelList')
    assert.ok(list)
    return list.props.children as VNode[]
  }
  const choices = rows()
  assert.equal(choices.length, 2)

  const tieredDetails = find(choices[0], 'modelDetails')
  assert.ok(tieredDetails)
  const tierSection = find(tieredDetails, 'modelTier')
  assert.ok(tierSection)
  const tierSelect = childrenOf(tierSection).find(c => c?.type === 'menu')
  assert.ok(tierSelect)
  assert.equal(tierSelect.props.selectedId, 'small')

  const singleDetails = find(choices[1], 'modelDetails')
  assert.ok(singleDetails)
  assert.equal(find(singleDetails, 'modelTier'), undefined)
  const metadata = find(singleDetails, 'modelMetadata')
  assert.ok(metadata)
  const nameGroup = (row: VNode) => {
    const rowHead = find(row, 'modelChoiceHead')!
    return find(find(rowHead, 'modelChoiceLabel')!, 'modelName')!
  }
  const ratedName = nameGroup(choices[0])
  assert.equal(ratedName.type, 'span')
  const rate = find(ratedName, 'modelRate')!
  const [, visual] = (rate.props.children as VNode).props.children as VNode[]
  const [original, discounted] = visual.props.children as VNode[]
  const [, strikethrough] = original.props.children as VNode[]
  assert.equal(strikethrough.type, 'del')
  assert.equal(strikethrough.props.children, '1×')
  assert.equal(discounted.props.tone, 'success')
  assert.equal(discounted.props.children, '0.5×')
  const missingName = nameGroup(choices[1])
  assert.equal(find(missingName, 'modelRate'), undefined)
  assert.equal(find(missingName, 'modelMissing')?.props.children, 'modelMissingFromCatalog')
  const head = find(choices[1], 'modelChoiceHead')
  assert.ok(head)
  const actions = find(head, 'modelActions')
  assert.ok(actions)
  const remove = find(actions, 'modelDelete')
  assert.equal(remove?.props.children, 'modelDelete')

  // Selecting a new tier saves the updated model to its mounted region
  const selectHandler = tierSelect.props.onSelect as (key: string) => void
  selectHandler('large')
  assert.equal(changedModels.length, 2)
  assert.equal(changedModels[0].id, 'tiered')
  assert.equal(changedModels[0].contextTier, 'large')
  assert.equal(changedModels[0].contextWindow, 1_000_000)
  assert.equal(changedModels[1].id, 'single')
  await nextTurn()

  const checkbox = (row: VNode) => {
    const header = find(row, 'modelChoiceHead')
    assert.ok(header)
    const label = find(header, 'modelChoiceLabel')
    assert.equal(label?.type, 'label')
    const [input] = label!.props.children as VNode[]
    assert.equal(input.type, 'input')
    return input
  }
  const unchecked = checkbox(rows()[1])
  assert.equal(unchecked.props.checked, false)
  assert.equal(unchecked.props.disabled, false)
  const change = unchecked.props.onChange as (event: { currentTarget: { checked: boolean } }) => void
  change({ currentTarget: { checked: true } })
  const during = rows()
  const saving = checkbox(during[1])
  assert.equal(saving.props.checked, true)
  assert.equal(saving.props.disabled, false)
  assert.equal(saving.props['aria-disabled'], undefined)
  assert.equal(checkbox(during[0]).props.disabled, false)
  assert.equal(toggleCalls, 0)
  const saveFeedback = () => {
    cursor = 0
    return childrenOf(render(keyed.props))[1]
  }
  assert.equal(saveFeedback(), null)
  reportStatus({ region: 'global', refreshing: true })
  assert.equal(saveFeedback()?.props.children, 'modelWaitingForCatalog')
  t.mock.timers.tick(2000)
  assert.equal(toggleCalls, 0)
  reportStatus({ region: 'global', refreshing: false })
  assert.equal(toggleCalls, 1)
  const feedback = saveFeedback()!
  const renderFeedback = (node: VNode) => {
    cursor = 2
    return (node.type as (props: object) => VNode | null)(node.props)
  }
  assert.equal(renderFeedback(feedback), null)
  t.mock.timers.tick(499)
  assert.equal(renderFeedback(feedback), null)
  t.mock.timers.tick(1)
  assert.equal(renderFeedback(feedback)?.props.children, 'saving')
  toggle.resolve()
  await nextTurn()
  assert.equal(checkbox(rows()[1]).props.checked, false)
  assert.equal(checkbox(rows()[1]).props.disabled, false)
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
      readSessionTier: async (scope: { region: 'global'; sessionId: string; modelId: string }) => success(adapter.readSessionTier(scope)),
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

test('context tier menu supports keyboard navigation and preserves focus across an asynchronous save', async () => {
  const filename = new URL('../src/client/QoderContextSelect.tsx', import.meta.url)
  const require = createRequire(filename)
  const source = ts.transpileModule(await readFile(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText
  interface Cell { value?: unknown; deps?: readonly unknown[]; cleanup?: () => void }
  interface VNode { type: unknown; key?: string; ref?: unknown; props: { children?: unknown; [key: string]: unknown } }
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
  const nodes = (value: unknown): VNode[] => Array.isArray(value) ? value.flatMap(nodes)
    : value && typeof value === 'object' && 'props' in value ? [value as VNode, ...nodes((value as VNode).props.children)] : []
  const focusLog: string[] = []
  runInNewContext(source, {
    exports,
    document: { addEventListener() {}, removeEventListener() {} },
    require: (id: string) => id === 'react' ? {
      useState(initial: unknown) { const cell = next(); if (!('value' in cell)) cell.value = initial; return [cell.value, (value: unknown) => { cell.value = typeof value === 'function' ? value(cell.value) : value }] },
      useRef(initial: unknown) { const cell = next(); return cell.value ?? (cell.value = { current: initial }) },
      useMemo(create: () => unknown, deps: readonly unknown[]) { const cell = next(); if (!same(cell.deps, deps)) { cell.deps = deps; cell.value = create() }; return cell.value },
      useEffect: effect, useLayoutEffect: effect,
      useSyncExternalStore(subscribe: (fn: () => void) => () => void, read: () => unknown) {
        if (!subscriptions.has(subscribe)) subscriptions.set(subscribe, subscribe(() => {}))
        return read()
      },
    } : id.endsWith('.css') ? { __esModule: true, default: {} } : require(id),
  })
  const selection = (tierKey: 'small' | 'large') => ({ region: 'global' as const, sessionId: 's', modelId: 'a', tierKey, tokenCount: tierKey === 'small' ? 200_000 : 1_000_000 })
  let saveResolve: ((value: unknown) => void) | undefined
  let saveResult: unknown = success(selection('large'))
  let refreshPending = false
  let refreshResolve: ((value: unknown) => void) | undefined
  const props = {
    sessionId: 's',
    directory: { getSnapshot: () => ({ current: { provider: QODER_PROVIDER_ID, model: 'a' } }), subscribe: () => () => {} },
    operations: {
      getModelSnapshot: () => ({ value: { modelsByRegion: { global: [model] } } }), subscribeModels: () => () => {},
      readSessionTier: async () => refreshPending
        ? new Promise(resolve => { refreshResolve = resolve })
        : success(selection('small')),
      setSessionTier: async () => new Promise(resolve => { saveResolve = resolve }),
    },
  }
  const attachRefs = (tree: VNode) => {
    for (const node of nodes(tree)) {
      if (typeof node.ref !== 'function') continue
      const label = node.props.role === 'menuitemradio' ? String(node.key) : node.props['aria-expanded'] !== undefined ? 'trigger' : 'other'
      ;(node.ref as (element: unknown) => void)({ focus: () => { focusLog.push(label) } })
    }
  }
  const unmount = () => { for (const cell of cells) cell.cleanup?.(); for (const off of subscriptions.values()) off(); subscriptions.clear(); cells = [] }
  let tree!: VNode
  const render = () => {
    cursor = 0
    const outer = exports.QoderContextSelect(props)!
    tree = (outer.type as (props: object) => VNode)(outer.props)
    attachRefs(tree)
    for (const { cell, create } of effects.splice(0)) { cell.cleanup?.(); cell.cleanup = create() || undefined }
    return tree
  }
  const nodeWithRole = (role: string) => nodes(tree).find(node => node.props.role === role)
  const root = () => nodes(tree).find(node => typeof node.props.onBlurCapture === 'function')!
  const trigger = () => nodes(tree).find(node => node.props['aria-expanded'] !== undefined)!
  const menu = () => nodeWithRole('menu')
  try {
    render()
    await new Promise(resolve => setImmediate(resolve))
    render()
    assert.equal(trigger().props.disabled, false)
    assert.equal(trigger().props['aria-disabled'], false)
    assert.equal(trigger().props['aria-haspopup'], 'menu')

    ;(trigger().props.onClick as () => void)()
    render()
    assert.equal(menu()?.props.role, 'menu')
    assert.equal(focusLog.at(-1), 'small', 'opening focuses the selected tier')

    let prevented = false
    ;(menu()!.props.onKeyDown as (event: { key: string; preventDefault(): void }) => void)({ key: 'ArrowDown', preventDefault: () => { prevented = true } })
    render()
    assert.equal(prevented, true)
    assert.equal(focusLog.at(-1), 'large')
    assert.equal(nodes(menu()!).find(node => node.key === 'large')?.props.tabIndex, 0)

    ;(menu()!.props.onKeyDown as (event: { key: string; preventDefault(): void }) => void)({ key: 'ArrowUp', preventDefault: () => {} })
    assert.equal(focusLog.at(-1), 'small')
    ;(menu()!.props.onKeyDown as (event: { key: string; preventDefault(): void }) => void)({ key: 'Home', preventDefault: () => {} })
    assert.equal(focusLog.at(-1), 'small')
    ;(menu()!.props.onKeyDown as (event: { key: string; preventDefault(): void }) => void)({ key: 'End', preventDefault: () => {} })
    assert.equal(focusLog.at(-1), 'large')
    ;(menu()!.props.onKeyDown as (event: { key: string; preventDefault(): void }) => void)({ key: 'Escape', preventDefault: () => {} })
    render()
    assert.equal(menu(), undefined)
    assert.equal(focusLog.at(-1), 'trigger')

    ;(trigger().props.onClick as () => void)()
    render()
    let tabPrevented = false
    ;(menu()!.props.onKeyDown as (event: { key: string; preventDefault(): void }) => void)({ key: 'Tab', preventDefault: () => { tabPrevented = true } })
    assert.equal(tabPrevented, false)
    ;(root().props.onBlurCapture as (event: { currentTarget: { contains(value: unknown): boolean }; relatedTarget: unknown }) => void)({ currentTarget: { contains: () => false }, relatedTarget: {} })
    render()
    assert.equal(menu(), undefined)

    // A tier change disables the trigger while the host write is unresolved.
    ;(trigger().props.onClick as () => void)()
    render()
    const large = nodes(menu()!).find(node => node.key === 'large')!
    ;(large.props.onFocus as () => void)()
    ;(large.props.onClick as () => void)()
    render()
    assert.equal(trigger().props.disabled, false)
    assert.equal(trigger().props['aria-disabled'], true)
    assert.equal(menu(), undefined)
    assert.equal(focusLog.at(-1), 'trigger', 'selection keeps focus on the still-focusable trigger')
    ;(trigger().props.onClick as () => void)()
    render()
    assert.equal(menu(), undefined, 'aria-disabled trigger does not reopen while saving')
    saveResolve!(saveResult)
    await new Promise(resolve => setImmediate(resolve))
    render()
    assert.equal(trigger().props.disabled, false)
    assert.equal(trigger().props['aria-disabled'], false)
    assert.equal(focusLog.at(-1), 'trigger', 'saving completion preserves the current focus')

    // If focus has left the component during the write, completion must not steal it back.
    saveResult = { ok: false, error: { cause: 'connection', outcome: 'unknown', stage: 'set-session-tier', completedStages: [] } }
    ;(trigger().props.onClick as () => void)()
    render()
    const small = nodes(menu()!).find(node => node.key === 'small')!
    ;(small.props.onFocus as () => void)()
    ;(small.props.onClick as () => void)()
    render()
    ;(root().props.onBlurCapture as (event: { currentTarget: { contains(value: unknown): boolean }; relatedTarget: unknown }) => void)({ currentTarget: { contains: () => false }, relatedTarget: {} })
    const focusCountBeforeCompletion = focusLog.length
    saveResolve!(saveResult)
    await new Promise(resolve => setImmediate(resolve))
    render()
    assert.equal(focusLog.length, focusCountBeforeCompletion, 'completion does not reclaim focus after the user leaves')

    const alert = nodeWithRole('alert')
    assert.ok(alert)
    assert.equal(nodes(alert).some(node => node.type === 'button'), false)
    const refresh = nodes(tree).find(node => node.type === 'button' && node.props.children === 'refresh')!
    assert.ok(refresh)

    // A manual refresh may start while the menu is still open. Menu items must
    // become inert, and arrow keys must not move the roving tab stop while the
    // host read is pending.
    ;(trigger().props.onClick as () => void)()
    render()
    refreshPending = true
    ;(refresh.props.onClick as () => void)()
    render()
    const pendingItems = nodes(menu()!).filter(node => node.props.role === 'menuitemradio')
    assert.ok(pendingItems.length > 0)
    assert.ok(pendingItems.every(node => node.props.disabled === true))
    const focusedDuringRefresh = pendingItems.find(node => node.props.tabIndex === 0)?.key
    let arrowPrevented = false
    ;(menu()!.props.onKeyDown as (event: { key: string; preventDefault(): void }) => void)({ key: 'ArrowDown', preventDefault: () => { arrowPrevented = true } })
    render()
    assert.equal(arrowPrevented, false)
    assert.equal(nodes(menu()!).find(node => node.props.tabIndex === 0)?.key, focusedDuringRefresh)
    refreshResolve!(success(selection('large')))
    await new Promise(resolve => setImmediate(resolve))
    render()
    assert.ok(nodes(menu()!).filter(node => node.props.role === 'menuitemradio').every(node => node.props.disabled === false))
  } finally { unmount() }
})
