import test from 'node:test'
import assert from 'node:assert/strict'
import { mountBrowserLogin, nodes } from './helpers/browser-login.ts'
import type { QoderAuthorizationOperations } from '../src/client/credential-operations.ts'
import type { QoderAuthorizationView } from '../src/qoder/authorization.ts'
import type { QoderBrowserLoginProps } from '../src/client/QoderBrowserLogin.tsx'

const view = (): QoderAuthorizationView => ({ region: 'global', method: 'none', configured: false, writable: true })
const success = (value: QoderAuthorizationView) => ({ ok: true as const, value })
function fixture() {
  let current = view()
  const calls: string[] = []
  const operations: QoderAuthorizationOperations = {
    read: async () => success(current),
    begin: async () => {
      calls.push('begin')
      current = { ...current, attempt: { id: 'test-attempt', phase: 'waiting', url: 'https://qoder.com/device/selectAccounts?challenge=test', expiresAt: Date.now() + 300_000 } }
      return success(current)
    },
    cancel: async () => { calls.push('cancel'); current = { ...current, attempt: undefined }; return success(current) },
    select: async (_region, method) => { calls.push(method); current = { ...current, method, attempt: undefined }; return success(current) },
  }
  return { operations, calls, set(value: QoderAuthorizationView) { current = value } }
}

test('sign-in reserves a tab synchronously, then offers open/copy links and cancel while polling', async () => {
  const f = fixture()
  const ui = await mountBrowserLogin(f.operations)
  assert.equal(ui.click('Sign in with Qoder'), true)
  assert.equal(ui.opens(), 1)
  await ui.settle()
  assert.equal(ui.popup.opener, null)
  assert.match(ui.popup.url, /^https:\/\/qoder.com\/device\/selectAccounts/)
  assert.match(ui.text(), /Complete verification/)
  assert.ok(nodes(ui.tree()).some(node => node.type === 'a' && node.props.rel === 'noopener noreferrer'))
  assert.ok(!nodes(ui.tree()).some(node => node.type === 'button' && node.props.children === 'Sign in with Qoder'))
  assert.equal(ui.click('Cancel sign-in'), true)
  await ui.settle()
  assert.deepEqual(f.calls, ['begin', 'cancel'])
  ui.unmount()
})

test('blocked popups retain the manual authorization link and page unmount does not cancel the backend attempt', async () => {
  const f = fixture()
  const ui = await mountBrowserLogin(f.operations, { popup: false })
  ui.click('Sign in with Qoder')
  await ui.settle()
  assert.match(ui.text(), /Reopen Qoder website/)
  ui.unmount()
  assert.deepEqual(f.calls, ['begin'])
  assert.equal(ui.lateUpdates(), 0)
})

test('polling restores shared progress, displays completion and exposes explicit method selection and logout', async () => {
  const f = fixture()
  await f.operations.begin('global')
  const ui = await mountBrowserLogin(f.operations)
  assert.match(ui.text(), /Complete verification/)
  f.set({ ...view(), configured: true, method: 'browser', profile: { id: 'demo', name: 'Demo subscriber', email: 'demo@example.test' }, attempt: { id: 'test-attempt', phase: 'complete', expiresAt: Date.now() } })
  ui.poll(); await ui.settle()
  assert.match(ui.text(), /Manage account/)
  assert.match(ui.text(), /Demo subscriber/)
  assert.doesNotMatch(ui.text(), /Reopen Qoder website|Signed in/)
  ui.click('Manage account'); await ui.settle()
  ui.click('Use PAT'); await ui.settle()
  ui.click('Use saved PAT'); await ui.settle()
  assert.doesNotMatch(ui.text(), /demo@example.test/)
  ui.click('Manage credentials'); await ui.settle()
  ui.click('Use saved browser authorization'); await ui.settle()
  ui.click('Manage account'); await ui.settle()
  ui.click('Remove browser authorization'); await ui.settle()
  assert.deepEqual(f.calls, ['begin', 'pat', 'browser', 'none'])
  ui.unmount()
})

test('a late polling response cannot overwrite a successful login mutation', async () => {
  const f = fixture()
  const ui = await mountBrowserLogin(f.operations)
  let release!: (value: ReturnType<typeof success>) => void
  f.operations.read = () => new Promise(resolve => { release = resolve })
  ui.poll()
  ui.click('Sign in with Qoder')
  await ui.settle()
  release(success(view()))
  await ui.settle()
  assert.match(ui.text(), /Complete verification/)
  ui.unmount()
})

test('read-only authorization disables mutations and renewed unsaved credentials remain visible in both locales', async () => {
  for (const locale of ['en', 'zh'] as const) {
    const f = fixture()
    f.set({ ...view(), writable: false, method: 'browser', unsaved: true, expired: true })
    const ui = await mountBrowserLogin(f.operations, { locale })
    assert.equal(ui.click(locale === 'en' ? 'Sign in again' : '重新登录'), false)
    assert.match(ui.text(), locale === 'en' ? /have not been saved/ : /尚未保存/)
    assert.match(ui.text(), locale === 'en' ? /expired/ : /已失效/)
    ui.unmount()
  }
})

test('PAT editing is revealed on demand and saving uses the trimmed token without exposing an inactive browser identity', async () => {
  const f = fixture()
  f.set({ ...view(), method: 'browser', configured: true, profile: { id: 'browser-user', name: 'Browser subscriber', email: 'browser@example.test' } })
  const stored: string[] = []
  const busy: boolean[] = []
  const credentials: QoderBrowserLoginProps['credentials'] = {
    describe: async () => ({ configured: false, writable: true }),
    store: async value => { stored.push(value); await f.operations.select('global', 'pat'); f.set({ ...view(), method: 'pat', configured: true, profile: { id: 'browser-user', name: 'Browser subscriber', email: 'browser@example.test' } }); return true },
    remove: async () => true,
    getAccount: async () => ({ ok: true, value: { profile: { id: 'pat-user', name: 'PAT subscriber', email: 'pat@example.test' }, updatedAt: new Date().toISOString() } }),
  }
  const ui = await mountBrowserLogin(f.operations, { credentials, onBusyChange: value => busy.push(value) })
  assert.equal(nodes(ui.tree()).filter(node => node.type === 'input').length, 0)
  assert.doesNotMatch(ui.text(), /Change account|Use PAT/)
  ui.click('Manage account'); await ui.settle()
  ui.click('Use PAT'); await ui.settle()
  assert.equal(ui.click('Save and use PAT'), false)
  ui.input('  personal-test  '); await ui.settle()
  ui.click('Save and use PAT'); await ui.settle()
  assert.deepEqual(stored, ['personal-test'])
  assert.deepEqual(busy, [true, false])
  assert.match(ui.text(), /PAT subscriber|pat@example.test/)
  assert.doesNotMatch(ui.text(), /browser@example.test/)
  assert.equal(nodes(ui.tree()).filter(node => node.type === 'input').length, 0)
  ui.unmount()
})

test('PAT save failures retain the draft and display a specific retry message', async () => {
  const f = fixture()
  const ui = await mountBrowserLogin(f.operations, { credentials: {
    describe: async () => ({ configured: false, writable: true }),
    store: async () => false, remove: async () => true, getAccount: async () => undefined,
  } })
  ui.click('Use PAT'); await ui.settle()
  ui.input('test-draft'); await ui.settle()
  ui.click('Save and use PAT'); await ui.settle()
  assert.match(ui.text(), /Could not save or activate the PAT/)
  assert.equal(nodes(ui.tree()).find(node => node.type === 'input')!.props.value, 'test-draft')
  ui.unmount()
})

test('an expired browser authorization presents one primary reconnect action and a storage failure has a distinct explanation', async () => {
  const f = fixture()
  f.set({ ...view(), method: 'browser', expired: true, profile: { id: 'old-user', name: 'Previous subscriber', email: 'previous@example.test' } })
  const ui = await mountBrowserLogin(f.operations)
  assert.match(ui.text(), /Previous subscriber/)
  assert.ok(nodes(ui.tree()).some(node => node.type === 'button' && node.props.children === 'Sign in again'))
  f.set({ ...view(), attempt: { id: 'failed', phase: 'failed', failure: 'storage', expiresAt: Date.now() } })
  ui.poll(); await ui.settle()
  assert.match(ui.text(), /Website authorization completed, but credentials could not be saved/)
  ui.unmount()
})

test('a late PAT profile response after unmount cannot publish state', async () => {
  const f = fixture()
  f.set({ ...view(), method: 'pat', configured: true })
  let release!: (value: Awaited<ReturnType<QoderBrowserLoginProps['credentials']['getAccount']>>) => void
  const ui = await mountBrowserLogin(f.operations, { credentials: {
    describe: async () => ({ configured: true, writable: true }), store: async () => true, remove: async () => true,
    getAccount: () => new Promise(resolve => { release = resolve }),
  } })
  ui.unmount()
  release({ ok: true, value: { profile: { id: 'late', name: 'Late subscriber', email: 'late@example.test' }, updatedAt: new Date().toISOString() } })
  await ui.settle()
  assert.equal(ui.lateUpdates(), 0)
})

test('the unified card exposes regions immediately, saves on selection and keys identity by the accepted region', async () => {
  const f = fixture()
  let region: 'global' | 'china' = 'global'
  const changes: string[] = []
  const ui = await mountBrowserLogin(f.operations, { card: true,
    snapshot: () => ({ status: 'ready', writable: true, value: { region }, base: {}, user: {}, revision: 0 }),
    storeRegion: async next => { changes.push(next); region = next; return true },
  })
  assert.equal(nodes(ui.tree()).filter(node => node.props.role === 'radio').length, 2)
  assert.equal(nodes(ui.tree()).filter(node => node.type === 'input').length, 0)
  ui.childBusy(true); await ui.settle()
  assert.equal(ui.click('China (CN)'), false)
  ui.childBusy(false); await ui.settle()
  ui.click('China (CN)'); await ui.settle()
  assert.deepEqual(changes, ['china'])
  assert.ok(nodes(ui.tree()).some(node => node.props.region === 'china'))
  assert.match(ui.text(), /Region changed/)
  ui.unmount()
})

test('failed region writes retain the previous region and show a retry message', async () => {
  const f = fixture()
  const ui = await mountBrowserLogin(f.operations, { card: true, storeRegion: async () => false })
  ui.click('China (CN)'); await ui.settle()
  assert.ok(nodes(ui.tree()).some(node => node.props.region === 'global'))
  assert.match(ui.text(), /Could not change region/)
  ui.unmount()
})

test('browser authorization removal failures identify credential storage instead of reporting a connection failure', async () => {
  const f = fixture()
  f.set({ ...view(), method: 'browser', configured: true, profile: { id: 'subscriber', name: 'Subscriber', email: 'subscriber@example.test' } })
  f.operations.select = async () => ({ ok: false, error: { code: 'INTERNAL', message: 'Credential storage rejected the write' } })
  const ui = await mountBrowserLogin(f.operations)
  ui.click('Manage account'); await ui.settle()
  ui.click('Remove browser authorization'); await ui.settle()
  assert.match(ui.text(), /Could not remove browser authorization/)
  assert.match(ui.text(), /credential storage is writable/)
  assert.doesNotMatch(ui.text(), /Could not connect or read sign-in status/)
  assert.match(ui.text(), /subscriber@example.test/)
  ui.unmount()
})
