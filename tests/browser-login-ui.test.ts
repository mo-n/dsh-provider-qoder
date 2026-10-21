import test from 'node:test'
import assert from 'node:assert/strict'
import { mountBrowserLogin, nodes } from './helpers/browser-login.ts'
import type { QoderAuthorizationOperations } from '../src/client/credential-operations.ts'
import type { QoderAuthorizationView } from '../src/qoder/authorization.ts'

const view = (): QoderAuthorizationView => ({ region: 'global', method: 'pat', configured: true, writable: true })
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
  assert.equal(ui.click('Sign in with Qoder'), false)
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
  assert.match(ui.text(), /Open sign-in page/)
  ui.unmount()
  assert.deepEqual(f.calls, ['begin'])
  assert.equal(ui.lateUpdates(), 0)
})

test('polling restores shared progress, displays completion and exposes explicit method selection and logout', async () => {
  const f = fixture()
  await f.operations.begin('global')
  const ui = await mountBrowserLogin(f.operations)
  assert.match(ui.text(), /Complete verification/)
  f.set({ ...view(), method: 'browser', profile: { id: 'demo', name: 'Demo subscriber', email: 'demo@example.test' }, attempt: { id: 'test-attempt', phase: 'complete', expiresAt: Date.now() } })
  ui.poll(); await ui.settle()
  assert.match(ui.text(), /Signed in/)
  assert.match(ui.text(), /Demo subscriber/)
  assert.doesNotMatch(ui.text(), /Open sign-in page/)
  ui.click('Use PAT'); await ui.settle()
  assert.match(ui.text(), /Saved browser account/)
  ui.click('Use saved browser authorization'); await ui.settle()
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
    assert.equal(ui.click(locale === 'en' ? 'Sign in with Qoder' : '通过 Qoder 登录'), false)
    assert.match(ui.text(), locale === 'en' ? /have not been saved/ : /尚未保存/)
    assert.match(ui.text(), locale === 'en' ? /expired/ : /已失效/)
    ui.unmount()
  }
})
