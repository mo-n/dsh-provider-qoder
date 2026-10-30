import test from 'node:test'
import assert from 'node:assert/strict'
import { qoderCredentialRef } from '../src/dsh/credential-contract.ts'
import type { QoderRpcResult, QoderSessionTierSelection } from '../src/dsh/rpc-channel.ts'
import type { QoderAuthorizationView } from '../src/qoder/authorization.ts'
import { createSettingsOperations, type ModelForm, type QoderCredentialsRemote } from '../src/client/settings-operations.ts'
import { operationCause, type OperationResult } from '../src/client/operation-result.ts'
import { createQoderRpcCaller, type QoderRpcCaller } from '../src/client/rpc-client.ts'
import type { QoderAuthorizationOperations } from '../src/client/credential-operations.ts'

const view = (method: 'pat' | 'browser' = 'browser'): QoderAuthorizationView => ({ region: 'global', method, configured: true, writable: true })
const scope = { region: 'global' as const, sessionId: 'session', modelId: 'model' }
const selection: QoderSessionTierSelection = { ...scope, tierKey: 'large', tokenCount: 1_000_000 }
const secret = 'synthetic-secret-never-log'
function errorOf<T>(result: OperationResult<T>) { assert.equal(result.ok, false); if (result.ok) throw new Error('Expected failure'); return result.error }
function fixture() {
  let writes = 0
  let removals = 0
  let selections = 0
  let settingsWrites = 0
  const credentials: QoderCredentialsRemote = {
    describe: async () => ({ ok: true, value: { [qoderCredentialRef]: { configured: true, writable: true } } }),
    set: async () => { writes++; return { ok: true, value: undefined } },
    unset: async () => { removals++; return { ok: true, value: undefined } },
  }
  const form: ModelForm = {
    getSnapshot: () => ({ status: 'ready', value: { region: 'china' }, writable: true, base: {}, user: {}, revision: 1 }),
    subscribe: () => () => {},
    set: async () => { settingsWrites++; return true }, mutate: async () => { settingsWrites++; return true },
  }
  const authorization: QoderAuthorizationOperations = {
    read: async () => ({ ok: true, value: view() }), begin: async () => ({ ok: true, value: view() }), cancel: async () => ({ ok: true, value: view() }),
    select: async () => { selections++; return { ok: true, value: view('pat') } },
  }
  const rpc: QoderRpcCaller = { call: async <T>() => ({ ok: true, value: selection as T }) }
  return { credentials, form, authorization, rpc, operations: () => createSettingsOperations(credentials, form, authorization, rpc), counts: () => ({ writes, removals, selections, settingsWrites }) }
}

test('cause classification uses explicit evidence and never guesses from prose', () => {
  for (const [error, expected] of [
    [{ code: 'EACCES' }, 'permission-denied'], [{ status: 401 }, 'unauthenticated'], [{ code: 'ECONNRESET' }, 'connection'],
    [{ code: 'ETIMEDOUT' }, 'timeout'], [{ name: 'TimeoutError' }, 'timeout'], [{ name: 'AbortError' }, 'cancelled'],
    [{ code: 'PERSISTENCE_FAILED' }, 'persistence'], [false, 'unknown'], [new Error('permission denied timeout network'), 'unknown'],
  ] as const) assert.equal(operationCause(error), expected)
})

test('explicit credential refusal is not completed; diagnostics keep evidence and exclude secrets', async t => {
  const log = t.mock.method(console, 'error', () => {})
  const f = fixture()
  f.credentials.set = async () => ({ ok: false, error: { code: 'PERMISSION_DENIED', status: 403, message: secret } })
  const error = errorOf(await f.operations().store(secret))
  assert.equal(error.cause, 'permission-denied')
  assert.equal(error.outcome, 'not-completed')
  assert.equal(error.stage, 'persist-pat')
  assert.deepEqual(error.completedStages, [])
  assert.equal(error.diagnostic.status, 403)
  assert.equal(error.diagnostic.code, 'PERMISSION_DENIED')
  assert.equal(log.mock.callCount(), 1)
  assert.doesNotMatch(JSON.stringify(log.mock.calls), new RegExp(secret))
  assert.doesNotMatch(JSON.stringify(error), new RegExp(secret))
  assert.equal(f.counts().selections, 0)
})

test('bare false and rejected settings writes retain unknown completion despite a matching local snapshot', async t => {
  const log = t.mock.method(console, 'error', () => {})
  const f = fixture()
  f.form.set = async () => false
  f.form.mutate = async () => false
  const operations = f.operations()
  for (const result of await Promise.all([
    operations.storeRegion('china'), operations.storeModels('china', []), operations.storeWebSearchMode('disabled'),
    operations.storeImageSearchEnabled(false), operations.storeImageGenEnabled(false),
  ])) {
    const error = errorOf(result)
    assert.equal(error.cause, 'unknown')
    assert.equal(error.outcome, 'unknown')
  }
  assert.equal(log.mock.callCount(), 5)
  let attempted = 0
  f.form.set = async () => { attempted++; throw Object.assign(new Error(secret), { code: 'ECONNRESET', details: { token: secret } }) }
  const error = errorOf(await operations.storeRegion('china'))
  assert.equal(error.cause, 'connection')
  assert.equal(error.outcome, 'unknown')
  assert.equal(attempted, 1)
  assert.equal(log.mock.callCount(), 6)
  assert.doesNotMatch(JSON.stringify(log.mock.calls), new RegExp(secret))
})

for (const throws of [true, false]) test(`PAT saved before authorization failure retains partial completion (${throws ? 'exception' : 'RPC rejection'})`, async t => {
  const log = t.mock.method(console, 'error', () => {})
  const f = fixture()
  let reads = 0
  let attempts = 0
  f.authorization.read = async () => ++reads === 1 ? { ok: true, value: view() } : { ok: false, error: { code: 'INTERNAL', message: secret } }
  f.authorization.select = async () => { attempts++; if (throws) throw Object.assign(new Error(secret), { code: 'ECONNRESET' }); return { ok: false, error: { code: 'TIMEOUT', message: secret } } }
  const error = errorOf(await f.operations().store(secret))
  assert.equal(error.outcome, 'partial')
  assert.equal(error.stage, 'select-authorization')
  assert.deepEqual(error.completedStages, ['persist-pat'])
  assert.equal(error.cause, throws ? 'connection' : 'timeout')
  if (!throws) assert.equal(error.diagnostic.rpcCode, 'TIMEOUT')
  assert.equal(reads, 2)
  assert.equal(attempts, 1)
  assert.equal(f.counts().writes, 1)
  assert.equal(log.mock.callCount(), 1, 'reconciliation failure does not log the same operation again')
  assert.doesNotMatch(JSON.stringify(log.mock.calls), new RegExp(secret))
})

test('unknown PAT persistence is never confirmed by configured status or automatically replayed', async t => {
  const log = t.mock.method(console, 'error', () => {})
  const f = fixture()
  let attempted = 0
  f.credentials.set = async () => { attempted++; throw Object.assign(new Error(secret), { code: 'ECONNRESET' }) }
  const error = errorOf(await f.operations().store(secret))
  assert.equal(error.outcome, 'unknown')
  assert.deepEqual(error.completedStages, [])
  assert.equal(attempted, 1)
  assert.equal(f.counts().selections, 0)
  assert.equal(log.mock.callCount(), 1)
})

test('safe reads reconcile PAT authorization selection and removal without replaying writes', async t => {
  const log = t.mock.method(console, 'error', () => {})
  const f = fixture()
  let reads = 0
  let attempted = 0
  f.authorization.read = async () => ({ ok: true, value: view(++reads === 1 ? 'browser' : 'pat') })
  f.authorization.select = async () => { attempted++; throw Object.assign(new Error('offline'), { code: 'ECONNRESET' }) }
  assert.equal((await f.operations().store(secret)).ok, true)
  assert.equal(attempted, 1)
  assert.equal(f.counts().writes, 1)
  f.credentials.unset = async () => { throw Object.assign(new Error('offline'), { code: 'ECONNRESET' }) }
  f.credentials.describe = async () => ({ ok: true, value: { [qoderCredentialRef]: { configured: false, writable: true } } })
  assert.equal((await f.operations().remove()).ok, true)
  assert.equal(log.mock.callCount(), 0)
})

test('credential retrieval failures carry a cause without mutation completion', async t => {
  t.mock.method(console, 'error', () => {})
  const f = fixture()
  f.credentials.describe = async () => ({ ok: false, error: { code: 'PERMISSION_DENIED', message: secret } })
  const error = errorOf(await f.operations().describePat())
  assert.equal(error.cause, 'permission-denied')
  assert.equal(error.outcome, undefined)
  assert.deepEqual(error.completedStages, [])
})

for (const kind of ['permission', 'connection', 'timeout', 'cancelled', 'parse'] as const) test(`RPC evidence reaches Context Tier results safely: ${kind}`, async t => {
  const log = t.mock.method(console, 'error', () => {})
  const f = fixture()
  const requests: string[] = []
  const rpc = createQoderRpcCaller({ fetch: (async (path: string) => {
    requests.push(path)
    if (kind === 'permission') return new Response(null, { status: 403 })
    if (kind === 'connection') throw new TypeError(secret)
    if (kind === 'timeout') throw Object.assign(new Error(secret), { name: 'TimeoutError' })
    if (kind === 'cancelled') throw Object.assign(new Error(secret), { name: 'AbortError' })
    return { ok: true, json: async () => { throw new TypeError(secret) } } as unknown as Response
  }) as typeof fetch })
  const operations = createSettingsOperations(f.credentials, f.form, f.authorization, rpc)
  const result = await operations.setSessionTier(scope.sessionId, scope.modelId, 'large', scope.region)
  const error = errorOf(result)
  assert.equal(error.cause, { permission: 'permission-denied', connection: 'connection', timeout: 'timeout', cancelled: 'cancelled', parse: 'unknown' }[kind])
  assert.equal(error.outcome, kind === 'permission' ? 'not-completed' : 'unknown')
  assert.deepEqual(error.diagnostic.context, { ...scope, tierKey: 'large' })
  assert.equal(requests.length, kind === 'permission' ? 1 : 2, 'at most one safe read; no automatic write replay')
  assert.equal(log.mock.callCount(), 1)
  assert.doesNotMatch(JSON.stringify(log.mock.calls), new RegExp(secret))
})

test('Context Tier reconciliation confirms desired host state and failed reads preserve uncertainty', async t => {
  const log = t.mock.method(console, 'error', () => {})
  const f = fixture()
  const calls: string[] = []
  const rpc: QoderRpcCaller = { call: async <T>(endpoint: string): Promise<QoderRpcResult<T>> => {
    calls.push(endpoint)
    return endpoint === 'readSessionTier' ? { ok: true, value: selection as T } : { ok: false, error: { code: 'TIMEOUT', message: secret } }
  } }
  const operations = createSettingsOperations(f.credentials, f.form, f.authorization, rpc)
  assert.deepEqual(await operations.setSessionTier(scope.sessionId, scope.modelId, 'large', scope.region), { ok: true, value: selection })
  assert.deepEqual(calls, ['sessionTier', 'readSessionTier'])
  assert.equal(log.mock.callCount(), 0)
  rpc.call = async () => ({ ok: false, error: { code: 'UNAUTHENTICATED', message: secret } })
  const error = errorOf(await operations.readSessionTier(scope))
  assert.equal(error.outcome, undefined)
  assert.equal(error.cause, 'unauthenticated')
  assert.equal(error.diagnostic.rpcCode, 'UNAUTHENTICATED')
})

test('serialization errors do not become connection failures or submit an RPC request', async () => {
  let sends = 0
  const rpc = createQoderRpcCaller({ fetch: async () => { sends++; throw new Error('Unexpected send') } })
  const cyclic: { self?: unknown } = {}; cyclic.self = cyclic
  const result = await rpc.call('sessionTier', cyclic)
  assert.equal(result.ok, false)
  if (result.ok) throw new Error('Expected failure')
  assert.equal(operationCause(result.error), 'unknown')
  assert.equal(sends, 0)
})


test('explicit PAT removal refusal is not completed; thrown cancellation remains unknown', async t => {
  const log = t.mock.method(console, 'error', () => {})
  const f = fixture()
  let reads = 0
  f.credentials.describe = async () => { reads++; throw new Error('Read unavailable') }
  f.credentials.unset = async () => ({ ok: false, error: { code: 'PERMISSION_DENIED', message: secret } })
  let error = errorOf(await f.operations().remove())
  assert.equal(error.cause, 'permission-denied')
  assert.equal(error.outcome, 'not-completed')
  assert.equal(reads, 0)
  f.credentials.unset = async () => { throw Object.assign(new Error(secret), { name: 'AbortError' }) }
  error = errorOf(await f.operations().remove())
  assert.equal(error.cause, 'cancelled')
  assert.equal(error.outcome, 'unknown')
  assert.equal(reads, 1)
  assert.equal(log.mock.callCount(), 2)
})
