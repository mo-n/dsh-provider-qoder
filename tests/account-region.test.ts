import { success } from './helpers/operation-result.ts'
import { deferred } from './helpers/timing.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import type { QoderAccountInfo } from '../src/qoder/account.ts'
import type { QoderAccountResult, QoderCredentialStatus, QoderModelSettingsSnapshot } from '../src/client/credential-operations.ts'
import type { QoderRegion } from '../src/qoder/region.ts'

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
    : (id.endsWith('/QoderModelCatalog.tsx') || id.endsWith('/QoderFeatureSettings.tsx')) ? { QoderModelCatalog: () => null, QoderFeatureSettings: () => null } : require(id) })
  let region: QoderRegion = 'global'
  let snapshot: QoderModelSettingsSnapshot = { status: 'ready', value: { region, modelsByRegion: { global: [], china: [] } },
    base: {}, user: {}, revision: 0, writable: true, mode: 'host' }
  const requests: Array<{ region: QoderRegion; force?: boolean; result: ReturnType<typeof deferred<QoderAccountResult>> }> = []
  let onCredentialChange: (() => void) | undefined
  const operations = {
    describe: async () => success(await describe()),
    subscribe(listener: () => void) {
      onCredentialChange = listener
      return () => { onCredentialChange = undefined }
    },
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
    const child = exports.QoderAccountCard({
      operations,
      t: (copy: string, values?: Record<string, string | number>) => [copy, ...Object.values(values ?? {})].join(' '),
      activeLocale: () => 'en',
    })
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
    requests, settle, unmount, text: () => text(output), nodes: () => nodes(output), lateUpdates: () => lateUpdates,
    setRegion(nextRegion: QoderRegion) {
      region = nextRegion
      snapshot = { ...snapshot, value: { ...snapshot.value, region }, revision: (snapshot.revision ?? 0) + 1 }
      render()
    },
    updateModels() { snapshot = { ...snapshot, revision: (snapshot.revision ?? 0) + 1 }; render() },
    changeCredential() { onCredentialChange?.(); render() },
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

test('account failures show safe localized copy without upstream error text', async () => {
  const card = await mountCard()
  card.requests[0].result.resolve({ ok: false, error: { code: 'UPSTREAM_ERROR', message: 'signed upstream diagnostic' } })
  await card.settle()
  assert.match(card.text(), /accountFailed/u)
  assert.doesNotMatch(card.text(), /signed upstream diagnostic/u)
  card.unmount()
})


test('quota displays partial and unavailable balances and keeps them only through a same-account refresh failure', async () => {
  let browserSubscriberId = 'addon-user'
  const card = await mountCard(async () => ({ configured: true, writable: true, browserSubscriberId }))
  card.requests[0].result.resolve({ ok: true, value: {
    profile: { id: 'addon-user', name: 'Add-on subscriber', email: '' },
    usage: {
      expiresAt: '2027-01-01T00:00:00.000Z',
      userQuota: { remaining: 0, unit: 'credits' },
      addOnQuota: { total: 2600, used: 688, remaining: 1912, unit: 'credits' },
      orgResourcePackage: { remaining: 40, unit: 'credits' },
      dedicatedResourcePackages: [{
        remaining: 500,
        unit: 'credits',
        status: 'QUOTA_DETAIL_STATUS_EXPIRED',
        expiresAt: '2026-09-19T00:00:00.000Z',
        modelKeys: ['sonus-latest'],
      }],
    },
    updatedAt: '2026-10-19T00:00:00.000Z',
  } })
  await card.settle()
  assert.match(card.text(), /quotaRemaining 0 Credits/)
  assert.match(card.text(), /addOnQuotaTitle.*quotaRemaining 1,912 Credits/)
  assert.match(card.text(), /orgResourceTitle.*quotaRemaining 40 Credits/)
  assert.match(card.text(), /quotaStatusExpired.*quotaRemaining 500 Credits/)
  assert.match(card.text(), /quotaModelKeys sonus-latest/)
  assert.doesNotMatch(card.text(), /resetsAt|noQuota/)
  const progress = card.nodes().filter(node => node.type === 'progress')
  assert.equal(progress.length, 1)
  assert.equal(progress[0].props.value, 688)

  card.refresh()
  card.changeCredential()
  await card.settle()
  assert.equal(card.requests.length, 2, 'renewing browser authorization keeps the active refresh')
  card.requests[1].result.reject(new Error('Refresh failed'))
  await card.settle()
  assert.match(card.text(), /accountRefreshFailed.*accountLastUpdated/)
  assert.match(card.text(), /quotaRemaining 1,912 Credits/)
  assert.ok(card.nodes().some(node => node.type === 'button' && text(node.props.children) === 'retry'))

  browserSubscriberId = 'new-subscriber'
  card.changeCredential()
  assert.doesNotMatch(card.text(), /Add-on subscriber|1,912/)
  await card.settle()
  card.requests[2].result.resolve(account('New subscriber'))
  await card.settle()
  assert.match(card.text(), /New subscriber/)
  card.unmount()
})

test('quota displays dedicated resource packages without reported balances', async () => {
  const card = await mountCard()
  card.requests[0].result.resolve({ ok: true, value: {
    profile: { id: 'subscriber', name: 'Subscriber', email: '' },
    updatedAt: '2026-11-26T00:00:00.000Z',
    usage: {
      userQuota: { unit: 'credits' },
      dedicatedResourcePackages: [
        {
          unit: 'credits',
          available: true,
          title: { fallback: 'Sonus credits', values: {} },
          expiresAt: '2026-12-01T00:00:00.000Z',
          modelKeys: ['sonus-latest'],
        },
        {
          unit: 'credits',
          title: { fallback: 'Model access', values: {} },
          modelFamilies: ['sonus'],
        },
      ],
    },
  } })
  await card.settle()
  assert.match(card.text(), /Sonus credits.*quotaStatusAvailable.*dedicatedResourceExpiresAt.*quotaModelKeys sonus-latest/)
  assert.match(card.text(), /Model access.*quotaModelFamilies sonus/)
  assert.doesNotMatch(card.text(), /noQuota|userQuotaTitle|quotaRemaining/)
  card.unmount()
})
