import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import type { CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { QoderBrowserAuthorization } from '../src/qoder/transport/browser-authorization.ts'
import { QoderBrowserAuthorizationManager, browserAuthorizationKey } from '../src/dsh/browser-authorization.ts'
import { createQoderTransport } from '../src/qoder/transport/index.ts'
import type { QoderAuthorizationTransport, QoderBrowserGrant } from '../src/qoder/authorization.ts'
import type { QoderRegion } from '../src/qoder/region.ts'
import { QoderLlmError } from '../src/qoder/errors.ts'
import { createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
const json = (value: unknown) => new Response(JSON.stringify(value))
function grant(region: QoderRegion = 'global', id: string = region): QoderBrowserGrant {
  return { id, region, credentials: { userID: id, name: `Subscriber ${id}`, email: `${id}@example.test`,
    authToken: `device-${id}`, machineID: 'test-machine' }, refreshToken: `refresh-${id}`, expiresAt: Date.now() + 3_600_000 }
}

/** Serialized, clone-on-read durable store shared by restarted managers. */
function storage() {
  const records = new Map<string, CredentialRecord>()
  const locks = new Map<string, Promise<unknown>>()
  let failWrites = false
  let writable = true
  let beforeCommit: (() => Promise<void>) | undefined
  const provider = {
    resolve: async () => ({ value: 'saved-pat', source: 'file' }),
    describeRecord: async () => ({ configured: true, writable }),
    readRecord: async (key: string) => structuredClone(records.get(key)),
    modifyRecord: (key: string, mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>) => {
      const promise = (locks.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
        const next = await mutate(structuredClone(records.get(key)))
        if (next !== undefined) {
          assert.deepEqual(next, JSON.parse(JSON.stringify(next)), 'credential records must survive a JSON round trip, as required by credentials-local')
          await beforeCommit?.()
          if (failWrites || !writable) throw new Error('mock disk unavailable')
          records.set(key, structuredClone(next))
        }
        return structuredClone(records.get(key))
      })
      locks.set(key, promise)
      return promise
    },
  } as unknown as CredentialProvider
  return { provider, records,
    seed(value: QoderBrowserGrant) { records.set(browserAuthorizationKey(value.region), { kind: 'grant', payload: { version: 1, method: 'browser', grant: value } }) },
    fail(value: boolean) { failWrites = value }, readonly() { writable = false },
    beforeCommit(callback?: () => Promise<void>) { beforeCommit = callback },
  }
}
function fixture(store = storage(), refresh?: QoderAuthorizationTransport['refresh']) {
  const completions = new Map<QoderRegion, ReturnType<typeof deferred<QoderBrowserGrant>>>()
  let begins = 0
  const manager = new QoderBrowserAuthorizationManager({ credentials: store.provider, changed: () => {},
    transport: region => ({
      begin: async () => {
        begins++
        const done = deferred<QoderBrowserGrant>()
        completions.set(region, done)
        return { url: `https://${region === 'china' ? 'qoder.cn' : 'qoder.com'}/device/selectAccounts?challenge=test`,
          expiresAt: Date.now() + 300_000, complete: () => done.promise }
      },
      refresh: refresh ?? (async value => value),
    }),
  })
  return { store, manager, completions, begins: () => begins,
    async finish(region: QoderRegion, value = grant(region)) { completions.get(region)!.resolve(value); await tick() },
  }
}

test('browser device flow binds PKCE to the website, polls 404, verifies identity and returns region-scoped credentials', async () => {
  for (const region of ['global', 'china'] as const) {
    let website!: URL
    let polls = 0
    const auth = new QoderBrowserAuthorization({ region, pollIntervalMs: 1, resolveMachineId: () => 'bound-machine',
      fetch: (async (input: RequestInfo | URL) => {
        const url = new URL(String(input))
        assert.equal(url.hostname, region === 'china' ? 'openapi.qoder.com.cn' : 'openapi.qoder.sh')
        if (url.pathname.endsWith('/poll')) {
          assert.equal(url.searchParams.get('nonce'), website.searchParams.get('nonce'))
          const verifier = url.searchParams.get('verifier')!
          assert.equal(createHash('sha256').update(verifier).digest('base64url'), website.searchParams.get('challenge'))
          return ++polls === 1 ? new Response('', { status: 404 })
            : json({ token: 'device-test', refresh_token: 'refresh-test', expires_in: 3600, refresh_token_expires_in: 30 * 86400 })
        }
        assert.equal(url.pathname, '/api/v1/userinfo')
        return json({ id: 'verified-id', name: 'Verified subscriber', email: 'verified@example.test' })
      }) as typeof fetch,
    })
    const flow = await auth.begin(new AbortController().signal)
    website = new URL(flow.url)
    assert.equal(website.origin, region === 'china' ? 'https://qoder.cn' : 'https://qoder.com')
    assert.equal(website.searchParams.get('machine_id'), 'bound-machine')
    assert.equal(website.searchParams.get('challenge_method'), 'S256')
    assert.equal(website.searchParams.has('verifier'), false)
    const result = await flow.complete()
    assert.equal(result.region, region)
    assert.equal(result.credentials.userID, 'verified-id')
    assert.equal(result.credentials.machineID, 'bound-machine')
    assert.equal(result.refreshToken, 'refresh-test')
    assert.ok(result.refreshExpiresAt! > result.expiresAt)
    assert.ok(result.refreshExpiresAt! > Date.now() + 29 * 86_400_000, 'multi-day refresh lifetimes are seconds, not milliseconds')
    assert.equal(polls, 2)
  }
})

test('browser polling cancellation, timeout and malformed responses never expose verifier or provider bodies', async () => {
  const controller = new AbortController()
  const cancelledAuth = new QoderBrowserAuthorization({ region: 'global', pollIntervalMs: 1, resolveMachineId: () => 'test',
    fetch: (async () => { controller.abort(); throw new Error('sensitive URL') }) as typeof fetch })
  const flow = await cancelledAuth.begin(controller.signal)
  await assert.rejects(flow.complete(), (error: QoderLlmError) => error.code === 'ABORTED' && !error.message.includes('sensitive'))
  const timeoutAuth = new QoderBrowserAuthorization({ region: 'global', loginTimeoutMs: 5, pollIntervalMs: 1, resolveMachineId: () => 'test',
    fetch: (async () => new Response('', { status: 404 })) as typeof fetch })
  await assert.rejects((await timeoutAuth.begin(new AbortController().signal)).complete(), (error: QoderLlmError) => error.code === 'TIMEOUT')
  const badAuth = new QoderBrowserAuthorization({ region: 'global', resolveMachineId: () => 'test',
    fetch: (async () => new Response('private-provider-body')) as typeof fetch })
  await assert.rejects((await badAuth.begin(new AbortController().signal)).complete(), (error: QoderLlmError) => error.code === 'MALFORMED_RESPONSE' && !error.message.includes('private'))
})

test('device renewal is lazy, rotates both tokens, preserves subscriber identity and uses the matching region', async () => {
  let calls = 0
  const auth = new QoderBrowserAuthorization({ region: 'china', fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls++
    assert.equal(String(input), 'https://openapi.qoder.com.cn/api/v1/deviceToken/refresh')
    assert.deepEqual(JSON.parse(String(init?.body)), { refresh_token: 'refresh-china', machine_id: 'test-machine' })
    return json({ device_token: 'rotated-device', refresh_token: 'rotated-refresh', expires_in: 3600 })
  }) as typeof fetch })
  const original = grant('china')
  assert.equal(await auth.refresh(original), original)
  assert.equal(calls, 0)
  const rotated = await auth.refresh(original, undefined, original.credentials.authToken)
  assert.equal(rotated.credentials.authToken, 'rotated-device')
  assert.equal(rotated.refreshToken, 'rotated-refresh')
  assert.equal(rotated.credentials.userID, original.credentials.userID)
  assert.equal(rotated.id, original.id)
  assert.equal(calls, 1)
})

test('shared login persists JSON-only credentials, excludes secrets from views and survives restart', async () => {
  const f = fixture()
  assert.equal((await f.manager.describe('global')).method, 'pat')
  await Promise.all([f.manager.begin('global'), f.manager.begin('global')])
  assert.equal(f.begins(), 1)
  const value = grant()
  value.refreshExpiresAt = undefined
  value.credentials.organizationId = undefined
  value.credentials.organizationTags = undefined
  await f.finish('global', value)
  const view = await f.manager.describe('global')
  assert.equal(view.attempt?.phase, 'complete')
  assert.equal(view.configured, true)
  assert.equal(view.method, 'browser')
  assert.equal(view.profile?.id, 'global')
  assert.doesNotMatch(JSON.stringify(view), /device-global|refresh-global|authToken|refreshToken|machineID/)
  await f.manager.dispose()
  const restarted = fixture(f.store)
  const lease = await restarted.manager.lease('global')
  assert.equal((await lease!.resolve()).authToken, 'device-global')
  assert.equal((await restarted.manager.describe('china')).method, 'pat')
  await restarted.manager.dispose()
})

test('late completion after cancellation cannot replace the previous subscriber or another region', async () => {
  const f = fixture()
  f.store.seed(grant('global', 'previous'))
  await f.manager.begin('global')
  const cancelling = f.manager.cancel('global')
  await f.finish('global', grant('global', 'late'))
  await cancelling
  assert.equal((await f.manager.describe('global')).profile?.id, 'previous')
  assert.equal((await f.manager.describe('global')).attempt?.phase, 'cancelled')
  assert.equal((await f.manager.describe('china')).profile, undefined)
  await f.manager.dispose()
})

test('failed login persistence preserves the prior authorization', async () => {
  const f = fixture()
  f.store.seed(grant('global', 'previous'))
  await f.manager.begin('global')
  f.store.fail(true)
  await f.finish('global', grant('global', 'replacement'))
  assert.equal((await f.manager.describe('global')).profile?.id, 'previous')
  assert.equal((await f.manager.describe('global')).attempt?.phase, 'failed')
  assert.equal((await f.manager.describe('global')).attempt?.failure, 'storage')
  await f.manager.dispose()
})

test('cancellation while the store is committing restores the prior authorization', async () => {
  const f = fixture()
  f.store.seed(grant('global', 'previous'))
  const committing = deferred<void>()
  const release = deferred<void>()
  f.store.beforeCommit(async () => { committing.resolve(); await release.promise })
  await f.manager.begin('global')
  f.completions.get('global')!.resolve(grant('global', 'replacement'))
  await committing.promise
  const cancelled = f.manager.cancel('global')
  f.store.beforeCommit(undefined)
  release.resolve()
  await cancelled
  assert.equal((await f.manager.describe('global')).profile?.id, 'previous')
  await f.manager.dispose()
})

test('concurrent rejections serialize one rotation, and another process reuses the saved token', async () => {
  const store = storage()
  const original = grant()
  store.seed(original)
  let rotations = 0
  const refresh: QoderAuthorizationTransport['refresh'] = async (value, _signal, rejected) => {
    if (rejected !== value.credentials.authToken) return value
    rotations++
    await tick()
    return { ...value, credentials: { ...value.credentials, authToken: 'rotated-device' }, refreshToken: 'rotated-refresh' }
  }
  const first = fixture(store, refresh)
  const second = fixture(store, refresh)
  const a = (await first.manager.lease('global'))!
  const b = (await second.manager.lease('global'))!
  const results = await Promise.all([a.resolve(undefined, original.credentials.authToken), b.resolve(undefined, original.credentials.authToken)])
  assert.equal(rotations, 1)
  assert.ok(results.every(value => value.authToken === 'rotated-device'))
  await first.manager.dispose()
  await second.manager.dispose()
})

test('rotated credentials survive a failed write in memory and are saved on next use without rotating again', async () => {
  const original = grant()
  let rotations = 0
  const f = fixture(storage(), async (value, _signal, rejected) => {
    if (rejected !== value.credentials.authToken) return value
    rotations++
    return { ...value, credentials: { ...value.credentials, authToken: 'new-device' }, refreshToken: 'new-refresh' }
  })
  f.store.seed(original)
  const lease = (await f.manager.lease('global'))!
  f.store.fail(true)
  assert.equal((await lease.resolve(undefined, original.credentials.authToken)).authToken, 'new-device')
  assert.equal((await f.manager.describe('global')).unsaved, true)
  f.store.fail(false)
  assert.equal((await lease.resolve()).authToken, 'new-device')
  assert.equal((await f.manager.describe('global')).unsaved, false)
  assert.equal(rotations, 1)
  const restarted = fixture(f.store)
  assert.equal((await (await restarted.manager.lease('global'))!.resolve()).authToken, 'new-device')
  await restarted.manager.dispose()
  await f.manager.dispose()
})

test('logout fences stale refresh and does not silently fall back to a saved PAT, including after restart', async () => {
  const f = fixture()
  f.store.seed(grant())
  const lease = (await f.manager.lease('global'))!
  await f.manager.select('global', 'none')
  assert.deepEqual(await f.store.provider.readRecord(browserAuthorizationKey('global')), {
    kind: 'grant', payload: { version: 1, method: 'none' },
  })
  await assert.rejects(lease.resolve(undefined, 'device-global'), (error: QoderLlmError) => error.code === 'ABORTED')
  await assert.rejects(f.manager.lease('global'), (error: QoderLlmError) => error.code === 'MISSING_CREDENTIAL')
  const restarted = fixture(f.store)
  await assert.rejects(restarted.manager.lease('global'), (error: QoderLlmError) => error.code === 'MISSING_CREDENTIAL')
  assert.equal((await restarted.manager.select('global', 'pat')).method, 'pat')
  assert.equal(await restarted.manager.lease('global'), undefined)
  await f.manager.dispose()
  await restarted.manager.dispose()
})

test('transient refresh failures retain authorization while explicit invalidation requires sign-in', async () => {
  let code = 'TRANSPORT'
  const f = fixture(storage(), async () => { throw new QoderLlmError('mock refresh failure', code) })
  f.store.seed(grant())
  const lease = (await f.manager.lease('global'))!
  await assert.rejects(lease.resolve(undefined, 'device-global'))
  assert.equal((await f.manager.describe('global')).expired, false)
  code = 'AUTH'
  await assert.rejects(lease.resolve(undefined, 'device-global'))
  assert.equal((await f.manager.describe('global')).expired, true)
  await assert.rejects(f.manager.lease('global'), (error: QoderLlmError) => error.code === 'AUTH')
  const restarted = fixture(f.store)
  await assert.rejects(restarted.manager.lease('global'), (error: QoderLlmError) => error.code === 'AUTH')
  await restarted.manager.select('global', 'pat')
  assert.equal((await restarted.manager.describe('global')).configured, true)
  assert.equal((await restarted.manager.describe('global')).expired, false)
  await restarted.manager.dispose()
  await f.manager.dispose()
})

test('read-only stores cannot start authorization, and a corrupt record never falls back to PAT', async () => {
  const f = fixture()
  f.store.readonly()
  await assert.rejects(f.manager.begin('global'), /read-only/)
  assert.equal(f.begins(), 0)
  f.store.records.set(browserAuthorizationKey('global'), { kind: 'grant', payload: { version: 99, method: 'browser' } })
  await assert.rejects(f.manager.lease('global'), /invalid/)
  assert.equal((await f.manager.describe('global')).configured, false)
  await f.manager.dispose()
})

test('a previously saved fresh authorization can still be used when the credential store becomes read-only', async () => {
  const f = fixture()
  f.store.seed(grant())
  f.store.readonly()
  const lease = (await f.manager.lease('global'))!
  assert.equal((await lease.resolve()).authToken, 'device-global')
  await f.manager.dispose()
})

test('region changes fence a login delayed by the writability check and cancel an already waiting login', async () => {
  const f = fixture()
  const original = f.store.provider.describeRecord.bind(f.store.provider)
  const release = deferred<void>()
  f.store.provider.describeRecord = async key => { await release.promise; return original(key) }
  const starting = f.manager.begin('global')
  f.manager.activateRegion('china')
  release.resolve()
  await assert.rejects(starting, (error: QoderLlmError) => error.code === 'ABORTED')
  assert.equal(f.begins(), 0)
  f.manager.activateRegion('global')
  await f.manager.begin('global')
  f.manager.activateRegion('china')
  await f.finish('global')
  assert.equal((await f.manager.describe('global')).method, 'pat')
  assert.equal((await f.manager.describe('global')).attempt?.phase, 'cancelled')
  await f.manager.dispose()
})

test('caller cancellation immediately after upstream rotation does not discard the new refresh token', async () => {
  const controller = new AbortController()
  const f = fixture(storage(), async value => {
    controller.abort()
    return { ...value, credentials: { ...value.credentials, authToken: 'rotated-after-cancel' }, refreshToken: 'rotated-refresh' }
  })
  f.store.seed(grant())
  const lease = (await f.manager.lease('global'))!
  await assert.rejects(lease.resolve(controller.signal, 'device-global'), (error: QoderLlmError) => error.code === 'ABORTED')
  const saved = await f.store.provider.readRecord(browserAuthorizationKey('global'))
  assert.equal((saved as { payload: { grant: QoderBrowserGrant } }).payload.grant.refreshToken, 'rotated-refresh')
  await f.manager.dispose()
})

test('an existing operation keeps its subscriber after replacement while new operations use the replacement', async () => {
  const f = fixture()
  f.store.seed(grant('global', 'first'))
  const old = (await f.manager.lease('global'))!
  await f.manager.begin('global')
  await f.finish('global', grant('global', 'second'))
  assert.equal((await old.resolve()).userID, 'first')
  assert.equal((await (await f.manager.lease('global'))!.resolve()).userID, 'second')
  await assert.rejects(old.resolve(undefined, 'device-first'), (error: QoderLlmError) => error.code === 'ABORTED')
  await f.manager.dispose()
})

test('browser credentials power model discovery and account reads without PAT exchange, recovering one authentication rejection', async () => {
  const store = storage()
  store.seed(grant())
  let rotations = 0
  const f = fixture(store, async (value, _signal, rejected) => {
    if (rejected !== value.credentials.authToken) return value
    rotations++
    return { ...value, credentials: { ...value.credentials, authToken: 'renewed-device' } }
  })
  let modelCalls = 0
  const transport = createQoderTransport({ region: 'global', resolvePat: async () => { throw new Error('PAT must not be read') },
    resolveCredential: signal => f.manager.lease('global', signal),
    fetch: (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/model/list')) return ++modelCalls === 1 ? new Response('', { status: 401 }) : json({ assistant: [{ key: 'cmodel', enable: true, display_name: 'Cantus' }] })
      if (url.includes('/quota/usage')) return json({ userQuota: { total: 10, used: 1 } })
      if (url.includes('/user/plan') || url.includes('/user/status')) return json({})
      throw new Error('Unexpected upstream route')
    }) as typeof fetch })
  assert.equal((await transport.discoverModels())[0].id, 'cmodel')
  assert.equal(rotations, 1)
  assert.equal((await transport.readAccount()).profile.id, 'global')
  await f.manager.dispose()
})

test('browser authorization streams model output and retries a pre-stream rejection with rotated credentials and the same body', async () => {
  const f = fixture(storage(), async (value, _signal, rejected) => rejected === value.credentials.authToken
    ? { ...value, credentials: { ...value.credentials, authToken: 'renewed-for-chat' } } : value)
  f.store.seed(grant())
  const bodies: string[] = []
  const transport = createQoderTransport({ region: 'global', resolvePat: async () => { throw new Error('Unexpected PAT resolution') },
    resolveCredential: signal => f.manager.lease('global', signal),
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      assert.match(String(input), /agent_chat_generation/)
      bodies.push(String(init?.body))
      return bodies.length === 1 ? new Response('', { status: 401 }) : new Response(
        [{ choices: [{ delta: { content: 'browser-authorized output' }, finish_reason: 'stop' }] }, '[DONE]']
          .map(body => `data: ${JSON.stringify({ statusCodeValue: 200, body: typeof body === 'string' ? body : JSON.stringify(body) })}\n\n`).join(''),
        { headers: { 'content-type': 'text/event-stream' } },
      )
    }) as typeof fetch,
  })
  const chunks = []
  const request: GenerateOptions = { provider: 'dsh-provider-qoder', model: 'cmodel', messages: [
    createUserMessage({ content: [{ type: 'text', text: 'offline test' }], source: { kind: 'user' } }),
  ] }
  for await (const chunk of transport.stream(request, { id: 'cmodel', name: 'Cantus' })) chunks.push(chunk)
  assert.match(JSON.stringify(chunks), /browser-authorized output/)
  assert.equal(bodies.length, 2)
  assert.equal(bodies[0], bodies[1])
  await f.manager.dispose()
})
