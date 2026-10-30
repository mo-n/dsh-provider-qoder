import { accepted } from './helpers/operation-result.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import type { QoderModelSettingsSnapshot } from '../src/client/credential-operations.ts'
import { en, zh } from '../src/client/locales.ts'
import { nodes, text } from './helpers/browser-login.ts'

async function mountFeatures(write: (field: string, value: unknown) => Promise<boolean> = async () => true) {
  const file = new URL('../src/client/QoderFeatureSettings.tsx', import.meta.url)
  const source = ts.transpileModule(await readFile(file, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  } }).outputText
  const require = createRequire(file)
  const cells: unknown[] = []
  let cursor = 0
  let tree: unknown
  let dirty = false
  let cleanup: (() => void) | undefined
  let snapshot: QoderModelSettingsSnapshot = { status: 'ready', writable: true, value: {}, base: {}, user: {}, revision: 1 }
  const hooks = {
    useState(initial: unknown) {
      const index = cursor++
      if (!(index in cells)) cells[index] = initial
      return [cells[index], (value: unknown) => { cells[index] = value; dirty = true }]
    },
    useRef(initial: unknown) {
      const index = cursor++
      return cells[index] ?? (cells[index] = { current: initial })
    },
    useLayoutEffect(create: () => () => void) { if (!cleanup) cleanup = create() },
  }
  const exports: Record<string, (props: object) => unknown> = {}
  runInNewContext(source, { exports, require: (id: string) => id === 'react' ? hooks
    // Test the feature settings contract; DSH owns primitive rendering and styling.
    : id === '@deepseek-ai/dsh-client-ui-primitives' ? { Button: 'button', Switch: 'input' }
    : id.endsWith('.css') ? { __esModule: true, default: new Proxy({}, { get: (_, prop) => String(prop) }) } : require(id) })
  const operations = {
    storeWebSearchMode: (value: unknown) => write('webSearchMode', value).then(accepted),
    storeImageSearchEnabled: (value: unknown) => write('imageSearchEnabled', value).then(accepted),
    storeImageGenEnabled: (value: unknown) => write('imageGenEnabled', value).then(accepted),
  }
  const render = () => {
    cursor = 0; dirty = false
    tree = exports.QoderFeatureSettings({ operations, snapshot, t: (key: keyof typeof en) => en[key] })
  }
  render()
  return {
    tree: () => tree,
    controls: () => nodes(tree).filter(node => node.type === 'button' || node.type === 'input'),
    text: () => text(tree),
    update(value: Partial<QoderModelSettingsSnapshot>) { snapshot = { ...snapshot, ...value }; render() },
    async settle() { for (let tick = 0; tick < 12; tick++) { await Promise.resolve(); if (dirty) render() } },
    unmount: () => cleanup?.(),
  }
}

test('feature settings show three search modes and default both image features on', async () => {
  const ui = await mountFeatures()
  const controls = ui.controls()
  assert.deepEqual(controls.slice(0, 3).map(node => text(node)), ['Auto', 'Always use Qoder', 'Disabled'])
  assert.deepEqual(controls.slice(0, 3).map(node => node.props['aria-checked']), [true, false, false])
  assert.deepEqual(controls.slice(3).map(node => node.props.checked), [true, true])
  ui.update({ value: { webSearchMode: 'disabled', imageSearchEnabled: false, imageGenEnabled: false } })
  assert.deepEqual(ui.controls().slice(3).map(node => node.props.checked), [false, false])
  assert.equal(ui.controls()[2].props['aria-checked'], true)
  assert.deepEqual([zh.searchModeAuto, zh.searchModeAlways, zh.searchModeDisabled], ['自动', '始终使用 Qoder', '关闭'])
})

test('feature settings disable writes when unavailable, loading or read only', async () => {
  const writes: unknown[] = []
  const ui = await mountFeatures(async (...args) => { writes.push(args); return true })
  for (const patch of [{ status: 'loading' as const }, { status: 'unavailable' as const }, { status: 'ready' as const, writable: false }]) {
    ui.update(patch)
    assert.ok(ui.controls().every(node => node.props.disabled === true))
    ;(ui.controls()[1].props.onClick as () => void)()
  }
  assert.deepEqual(writes, [])
})

test('feature writes serialize, retain the published snapshot and show rejected saves', async () => {
  let finish!: (accepted: boolean) => void
  const writes: unknown[] = []
  const ui = await mountFeatures((...args) => { writes.push(args); return new Promise(resolve => { finish = resolve }) })
  const toggles = ui.controls().slice(3)
  ;(toggles[0].props.onChange as (enabled: boolean) => void)(false)
  ;(toggles[1].props.onChange as (enabled: boolean) => void)(false)
  await ui.settle()
  assert.deepEqual(writes, [['imageSearchEnabled', false]])
  assert.ok(ui.controls().every(node => node.props.disabled === true))
  assert.equal(ui.controls()[3].props.checked, true)
  finish(false)
  await ui.settle()
  assert.match(ui.text(), /Failed to save the feature setting/)
  assert.ok(ui.controls().every(node => node.props.disabled === false))
  ;(ui.controls()[4].props.onChange as (enabled: boolean) => void)(false)
  finish(true)
  await ui.settle()
  assert.deepEqual(writes[1], ['imageGenEnabled', false])
  assert.doesNotMatch(ui.text(), /Failed to save/)
})

test('search mode writes surface exceptions and can be retried', async () => {
  const writes: unknown[] = []
  const ui = await mountFeatures(async (...args) => { writes.push(args); throw new Error('settings unavailable') })
  ;(ui.controls()[1].props.onClick as () => void)()
  await ui.settle()
  assert.deepEqual(writes, [['webSearchMode', 'always']])
  assert.match(ui.text(), /Failed to save/)
})
