import test from 'node:test'
import assert from 'node:assert/strict'
import { QoderAdapter } from '../src/dsh/adapter.ts'
import { createQoderRpcHandler } from '../src/dsh/rpc-handler.ts'
import type { QoderAccountInfo } from '../src/qoder/account.ts'
import type { QoderRegion } from '../src/qoder/region.ts'

const unused = (): never => { throw new Error('Unexpected dependency call') }
const signal = () => new AbortController().signal

function options(): Parameters<typeof createQoderRpcHandler>[0] {
  return {
    region: () => 'global',
    resolveTransport: unused,
    discoverModels: unused,
    authorization: { describe: unused, begin: unused, cancel: unused, select: unused },
    adapter: { readSessionTier: unused, setSessionTier: unused },
    readQueue: unused,
    restoreSession: async () => {},
  }
}

test('a retained RPC handler uses the current region and replacement transport', async () => {
  let region: QoderRegion = 'global'
  const reads: string[] = []
  const transport = (id: string) => ({
    readAccount: async (): Promise<QoderAccountInfo> => {
      reads.push(id)
      return { profile: { id, name: id, email: '' }, updatedAt: '2026-10-30' }
    },
  })
  let active = transport('global')
  const deps = options()
  deps.region = () => region
  deps.resolveTransport = () => active
  deps.authorization.describe = async region => ({ region, method: 'none', configured: false, writable: true })
  const handler = createQoderRpcHandler(deps)

  assert.equal((await handler('account', {}, signal())).ok, true)
  assert.equal((await handler('authorization', { region: 'global' }, signal())).ok, true)
  region = 'china'
  active = transport('china')
  const stale = await handler('authorization', { region: 'global' }, signal())
  assert.equal(stale.ok, false)
  if (!stale.ok) assert.equal(stale.error.code, 'INVALID_REQUEST')
  assert.equal((await handler('authorization', { region: 'china' }, signal())).ok, true)
  assert.equal((await handler('account', {}, signal())).ok, true)
  assert.deepEqual(reads, ['global', 'china'])
})

function sessionHost() {
  let restored = false
  const deps = options()
  const transport = { stream: unused, discoverModels: unused, readAccount: unused, searchWeb: unused }
  const adapter = new QoderAdapter({
    models: [{ id: 'model', name: 'Model', contextTier: 'small', contextWindow: 200_000,
      contextOptions: { small: { tokenCount: 200_000 }, large: { tokenCount: 1_000_000 } } }],
    resolveTransport: () => transport,
    sessions: { get: id => restored && id === 'session' ? { requestContext: () => undefined } : undefined },
  })
  deps.adapter = adapter
  deps.restoreSession = async () => { restored = true }
  return { deps, adapter }
}

const tierRequest = { region: 'global', sessionId: 'session', modelId: 'model', tierKey: 'large' }

test('Context Tier selection waits for host session restoration', async () => {
  const { deps, adapter } = sessionHost()
  const handler = createQoderRpcHandler(deps)
  const result = await handler('sessionTier', tierRequest, signal())
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(adapter.getSessionTier('session', 'model'), 'large')
  assert.deepEqual(result.ok && result.value, { ...tierRequest, tokenCount: 1_000_000 })
})

test('cancellation during session restoration prevents Context Tier mutation', async () => {
  const { deps, adapter } = sessionHost()
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const restore = deps.restoreSession
  deps.restoreSession = async id => { await pending; await restore(id) }
  const controller = new AbortController()
  const handler = createQoderRpcHandler(deps)
  const result = handler('sessionTier', tierRequest, controller.signal)
  controller.abort()
  release()
  const outcome = await result
  assert.equal(outcome.ok, false)
  if (!outcome.ok) assert.equal(outcome.error.code, 'ABORTED')
  assert.equal(adapter.getSessionTier('session', 'model'), undefined)
})
