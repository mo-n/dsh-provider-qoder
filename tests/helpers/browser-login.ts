/** Minimal stateful renderer for the actual sign-in component and its asynchronous effects. */
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import type { QoderAuthorizationOperations, QoderModelSettingsSnapshot } from '../../src/client/credential-operations.ts'
import type { QoderRegion } from '../../src/qoder/region.ts'
import { en, zh } from '../../src/client/locales.ts'
import type { QoderBrowserLoginProps } from '../../src/client/QoderBrowserLogin.tsx'

export interface VNode { type: unknown; props: { children?: unknown; [key: string]: unknown } }
export function nodes(value: unknown): VNode[] {
  if (Array.isArray(value)) return value.flatMap(nodes)
  if (!value || typeof value !== 'object' || !('props' in value)) return []
  const node = value as VNode
  return [node, ...nodes(node.props.children)]
}
export function text(value: unknown): string {
  if (Array.isArray(value)) return value.map(text).join(' ')
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (value && typeof value === 'object' && 'props' in value) return text((value as VNode).props.children)
  return ''
}

export async function mountBrowserLogin(operations: QoderAuthorizationOperations, options: {
  region?: QoderRegion; popup?: boolean; locale?: 'zh' | 'en'; credentials?: QoderBrowserLoginProps['credentials']; onBusyChange?(busy: boolean): void
  card?: boolean; snapshot?(): QoderModelSettingsSnapshot; storeRegion?(region: QoderRegion): Promise<boolean>
} = {}) {
  const file = new URL(options.card ? '../../src/client/QoderCredentialCard.tsx' : '../../src/client/QoderBrowserLogin.tsx', import.meta.url)
  const source = ts.transpileModule(await readFile(file, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  } }).outputText
  const require = createRequire(file)
  interface Cell { value?: unknown; deps?: readonly unknown[]; cleanup?: () => void }
  const cells: Cell[] = []
  let cursor = 0
  let dirty = true
  let mounted = true
  let lateUpdates = 0
  let tree: unknown
  let effects: Array<() => void> = []
  const timers = new Map<number, () => void>()
  let timerId = 0
  const popup = { opener: {} as unknown, closed: false, url: '', close() { this.closed = true }, location: { replace(url: string) { popup.url = url } } }
  let opens = 0
  const hooks = {
    useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
    useState(initial: unknown) {
      const cell = cells[cursor++] ?? (cells[cursor - 1] = { value: initial })
      return [cell.value, (value: unknown) => {
        if (!mounted) { lateUpdates++; return }
        cell.value = typeof value === 'function' ? value(cell.value) : value
        dirty = true
      }]
    },
    useRef(initial: unknown) {
      const cell = cells[cursor++] ?? (cells[cursor - 1] = { value: { current: initial } })
      return cell.value
    },
    useEffect(create: () => void | (() => void), deps: unknown[]) {
      const cell = cells[cursor++] ?? (cells[cursor - 1] = {})
      if (cell.deps?.length === deps.length && deps.every((value, i) => Object.is(value, cell.deps![i]))) return
      cell.deps = deps
      effects.push(() => { cell.cleanup?.(); cell.cleanup = create() || undefined })
    },
  }
  const exports: Record<string, (props: object) => unknown> = {}
  runInNewContext(source, { exports,
    require: (id: string) => id === 'react' ? hooks : id.endsWith('.css')
      ? { __esModule: true, default: new Proxy({}, { get: (_, prop) => String(prop) }) }
      : id.endsWith('/QoderBrowserLogin.tsx') ? { QoderBrowserLogin: () => null } : require(id),
    setTimeout: (callback: () => void) => { timers.set(++timerId, callback); return timerId },
    clearTimeout: (id: number) => timers.delete(id),
    window: { open: () => { opens++; return options.popup === false ? null : popup }, confirm: () => true }, navigator: {},
  })
  const copy = options.locale === 'zh' ? zh : en
  const credentials = options.credentials ?? {
    describe: async () => ({ configured: true, writable: true }), store: async () => true, remove: async () => true,
    getAccount: async () => undefined,
  }
  const cardOperations = { ...credentials, authorization: operations,
    getModelSnapshot: options.snapshot ?? (() => ({ status: 'ready', writable: true, value: { region: options.region ?? 'global' } })),
    subscribeModels: () => () => {}, storeRegion: options.storeRegion ?? (async () => true),
  }
  const render = () => {
    dirty = false; cursor = 0; effects = []
    tree = exports[options.card ? 'QoderCredentialCard' : 'QoderBrowserLogin']({ region: options.region ?? 'global', operations: options.card ? cardOperations : operations, credentials, onBusyChange: options.onBusyChange,
      t: (key: keyof typeof en, values?: Record<string, string | number>) => Object.entries(values ?? {}).reduce((copy, [key, value]) => copy.replaceAll(`{${key}}`, String(value)), copy[key]) })
    for (const effect of effects) effect()
  }
  const settle = async () => {
    for (let i = 0; i < 25; i++) { await Promise.resolve(); if (dirty && mounted) render() }
  }
  render()
  await settle()
  return { settle, popup, opens: () => opens, lateUpdates: () => lateUpdates, tree: () => tree, text: () => text(tree),
    click(label: string) {
      const button = nodes(tree).find(node => node.type === 'button' && text(node.props.children) === label)
      if (!button) throw new Error(`Missing button: ${label}`)
      if (button.props.disabled) return false
      ;(button.props.onClick as () => void)()
      return true
    },
    poll() { const current = [...timers.values()]; timers.clear(); for (const callback of current) callback() },
    input(value: string) {
      const field = nodes(tree).find(node => node.type === 'input')
      if (!field) throw new Error('Missing PAT input')
      ;(field.props.onChange as (event: unknown) => void)({ currentTarget: { value } })
    },
    childBusy(value: boolean) {
      const child = nodes(tree).find(node => typeof node.type === 'function' && typeof node.props.onBusyChange === 'function')
      if (!child) throw new Error('Missing account body')
      ;(child.props.onBusyChange as (value: boolean) => void)(value)
    },
    unmount() { mounted = false; for (const cell of cells) cell.cleanup?.() },
  }
}
