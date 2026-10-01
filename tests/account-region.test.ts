import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import type { QoderAccountInfo } from '../src/qoder/account.ts'
import type { QoderAccountResult, QoderCredentialStatus, QoderModelSettingsSnapshot } from '../src/client/credential-operations.ts'
import type { QoderRegion } from '../src/qoder/region.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function account(name: string): QoderAccountResult {
  return { ok: true, value: { profile: { id: name, name, email: `${name}@example.test` } } as QoderAccountInfo }
}
interface VNode { type: unknown; key?: string; props: { children?: unknown; [key: string]: unknown } }
function nodes(value: unknown): VNode[] {
  if (Array.isArray(value)) return value.flatMap(nodes)
  if (!value || typeof value !== 'object' || !('props' in value)) return []
  const node = value as VNode
  return [node, ...nodes(node.props.children)]
}
function text(value: unknown): string {
  if (Array.isArray(value)) return value.map(text).join(' ')
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (value && typeof value === 'object' && 'props' in value) return text((value as VNode).props.children)
  return ''
}

/** Stateful render harness exercising the card's effects, keyed remounts and cleanup. */
async function mountCard(describe = async (): Promise<QoderCredentialStatus> => ({ configured: true, writable: true })) {
  const filename = new URL('../src/client/QoderAccountCard.tsx', import.meta.url)
  const source = ts.transpileModule(await readFile(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText
  const require = createRequire(filename)
  interface Cell { value?: unknown; deps?: readonly unknown[]; cleanup?: () => void }
  interface Instance { cells: Cell[]; mounted: boolean }
  let instance: Instance = { cells: [], mounted: true }
  let key: string | undefined
  let cursor = 0
  let dirty = true
  let lateUpdates = 0
  let effects: Array<{ cell: Cell; create: () => void | (() => void) }> = []
  let output: unknown
  const next = (): Cell => instance.cells[cursor++] ?? (instance.cells[cursor - 1] = {})
  const same = (a: readonly unknown[] | undefined, b: readonly unknown[]) => a?.length === b.length && b.every((value, i) => Object.is(value, a[i]))
  const effect = (create: () => void | (() => void), deps: readonly unknown[]) => {
    const cell = next()
    if (!same(cell.deps, deps)) { cell.deps = deps; effects.push({ cell, create }) }
  }
  const hooks = {
    useState<T>(initial: T | (() => T)) {
      const cell = next()
      const owner = instance
      if (!('value' in cell)) cell.value = typeof initial === 'function' ? (initial as () => T)() : initial
      return [cell.value, (nextValue: T | ((value: T) => T)) => {
        if (!owner.mounted) { lateUpdates++; return }
        const value = typeof nextValue === 'function' ? (nextValue as (value: T) => T)(cell.value as T) : nextValue
        if (!Object.is(value, cell.value)) { cell.value = value; dirty = true }
      }]
    },
    useRef<T>(value: T) {
      const cell = next()
      return cell.value ?? (cell.value = { current: value })
    },
    useCallback(callback: unknown, deps: readonly unknown[]) {
      const cell = next()
      if (!same(cell.deps, deps)) { cell.value = callback; cell.deps = deps }
      return cell.value
    },
    useEffect: effect,
    useLayoutEffect: effect,
    useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
  }
  const exports: Record<string, (props: object) => VNode> = {}
  runInNewContext(source, { exports, require: (id: string) => id === 'react' ? hooks
    : id.endsWith('.css') ? { __esModule: true, default: new Proxy({}, { get: (_, prop) => String(prop) }) }
    : id.endsWith('/QoderModelCatalog.tsx') ? { QoderModelCatalog: () => null } : require(id) })
  let region: QoderRegion = 'global'
  let snapshot: QoderModelSettingsSnapshot = { status: 'ready', value: { region, modelsByRegion: { global: [], china: [] } },
    base: {}, user: {}, revision: 0, writable: true, mode: 'host' }
  const requests: Array<{ region: QoderRegion; force?: boolean; result: ReturnType<typeof deferred<QoderAccountResult>> }> = []
  const operations = {
    describe,
    subscribe: () => () => {},
    subscribeModels: () => () => {},
    getModelSnapshot: () => snapshot,
    getAccount(force?: boolean) {
      const result = deferred<QoderAccountResult>()
      requests.push({ region, force, result })
      return result.promise
    },
  }
  const unmount = () => {
    instance.mounted = false
    for (const cell of instance.cells) cell.cleanup?.()
  }
  const render = () => {
    const child = exports.QoderAccountCard({ operations, t: (copy: string) => copy, activeLocale: () => 'en' })
    if (key !== child.key) {
      unmount()
      instance = { cells: [], mounted: true }
      key = child.key
    }
    dirty = false
    cursor = 0
    effects = []
    output = (child.type as (props: object) => unknown)(child.props)
    for (const { cell, create } of effects) {
      cell.cleanup?.()
      cell.cleanup = create() || undefined
    }
  }
  const settle = async () => {
    for (let tick = 0; tick < 12; tick++) { await Promise.resolve(); if (dirty) render() }
  }
  render()
  await settle()
  return {
    requests, settle, unmount, text: () => text(output), lateUpdates: () => lateUpdates,
    setRegion(nextRegion: QoderRegion) {
      region = nextRegion
      snapshot = { ...snapshot, value: { ...snapshot.value, region }, revision: (snapshot.revision ?? 0) + 1 }
      render()
    },
    updateModels() { snapshot = { ...snapshot, revision: (snapshot.revision ?? 0) + 1 }; render() },
    refresh() {
      const button = nodes(output).find(node => node.type === 'button' && text(node.props.children) === 'refresh')
      assert.ok(button)
      const onClick = button.props.onClick as () => void
      onClick()
    },
  }
}

test('switching region immediately hides an accepted account and reads the new region', async () => {
  const card = await mountCard()
  assert.equal(card.requests.length, 1)
  card.requests[0].result.resolve(account('Global subscriber'))
  await card.settle()
  assert.match(card.text(), /Global subscriber/)
  card.setRegion('china')
  assert.doesNotMatch(card.text(), /Global subscriber/)
  await card.settle()
  assert.equal(card.requests[1].region, 'china')
  assert.equal(card.requests[1].force, false)
  card.requests[1].result.resolve(account('China subscriber'))
  await card.settle()
  assert.match(card.text(), /China subscriber/)
  card.updateModels()
  await card.settle()
  assert.equal(card.requests.length, 2, 'catalog changes within a region must not reread the account')
  card.unmount()
})

for (const outcome of ['success', 'failure', 'exception'] as const) {
  test(`late old-region ${outcome} cannot replace the account or clear a new refresh`, async () => {
    const card = await mountCard()
    const old = card.requests[0]
    card.setRegion('china')
    await card.settle()
    card.requests[1].result.resolve(account('China subscriber'))
    await card.settle()
    card.refresh()
    await card.settle()
    assert.match(card.text(), /refreshing/)
    if (outcome === 'success') old.result.resolve(account('Old global subscriber'))
    else if (outcome === 'failure') old.result.resolve({ ok: false, error: { code: 'UPSTREAM_ERROR', message: 'Old region error' } })
    else old.result.reject(new Error('Old region exception'))
    await card.settle()
    assert.match(card.text(), /China subscriber/)
    assert.match(card.text(), /refreshing/)
    assert.doesNotMatch(card.text(), /Old global|Old region/)
    assert.equal(card.lateUpdates(), 0)
    card.requests[2].result.resolve(account('Refreshed China subscriber'))
    await card.settle()
    assert.match(card.text(), /Refreshed China subscriber/)
    assert.doesNotMatch(card.text(), /refreshing/)
    card.unmount()
  })
}

test('switching region away and back does not revive the first Global request', async () => {
  const card = await mountCard()
  card.setRegion('china')
  await card.settle()
  card.setRegion('global')
  await card.settle()
  assert.equal(card.requests.length, 3)
  card.requests[2].result.resolve(account('Current Global subscriber'))
  await card.settle()
  card.requests[0].result.resolve(account('Obsolete Global subscriber'))
  card.requests[1].result.resolve(account('Obsolete China subscriber'))
  await card.settle()
  assert.match(card.text(), /Current Global subscriber/)
  assert.doesNotMatch(card.text(), /Obsolete/)
  assert.equal(card.lateUpdates(), 0)
  card.unmount()
})

test('same-region refresh still supersedes an earlier refresh', async () => {
  const card = await mountCard()
  card.requests[0].result.resolve(account('Initial subscriber'))
  await card.settle()
  card.refresh()
  card.refresh()
  await card.settle()
  card.requests[2].result.resolve(account('Latest subscriber'))
  await card.settle()
  card.requests[1].result.resolve(account('Older subscriber'))
  await card.settle()
  assert.match(card.text(), /Latest subscriber/)
  assert.doesNotMatch(card.text(), /Older subscriber/)
  card.unmount()
})

test('unmount invalidates pending credential reads before they can start an account read', async () => {
  const credentials = deferred<QoderCredentialStatus>()
  const card = await mountCard(() => credentials.promise)
  card.unmount()
  credentials.resolve({ configured: true, writable: true })
  await card.settle()
  assert.equal(card.requests.length, 0)
  assert.equal(card.lateUpdates(), 0)
})
