import test from 'node:test'
import assert from 'node:assert/strict'
import { QoderAuthService, jobTokenExpiry } from '../src/qoder/transport/auth.ts'
import { QoderLlmError } from '../src/qoder/errors.ts'

test('QoderAuthService exchanges once, resolves identity, and caches credentials', async () => {
  let exchangeCalls = 0
  let userInfoCalls = 0
  let exchangeHeaders: Record<string, string> | undefined
  let userInfoHeaders: Record<string, string> | undefined
  const fetchMock = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    if (url.includes('/jobToken/exchange')) {
      exchangeCalls++
      exchangeHeaders = init?.headers as Record<string, string>
      assert.deepEqual(JSON.parse(String(init?.body)), { personal_token: 'pt-test-token', machine_id: 'machine-test' })
      return new Response(JSON.stringify({ token: 'jt-token', expires_in: 3_600_000 }), { status: 200 })
    }
    if (url.includes('/userinfo')) {
      userInfoCalls++
      userInfoHeaders = init?.headers as Record<string, string>
      return new Response(JSON.stringify({ id: 'user-999', email: 'user@qoder.sh', name: 'Subscriber' }))
    }
    throw new Error(`unexpected URL: ${url}`)
  }
  const service = new QoderAuthService({
    fetch: fetchMock as typeof fetch,
    resolveMachineId: () => 'machine-test',
  })

  const first = await service.getCredentials('pt-test-token')
  const second = await service.getCredentials('pt-test-token')
  assert.equal(first.authToken, 'jt-token')
  assert.equal(first.userID, 'user-999')
  assert.equal(second, first)
  assert.equal(exchangeCalls, 1)
  assert.equal(userInfoCalls, 1)
  assert.equal(exchangeHeaders?.['cosy-clienttype'], '5')
  assert.equal(userInfoHeaders?.['cosy-clienttype'], '5')
})

test('QoderAuthService shares one exchange between concurrent callers', async () => {
  let exchangeCalls = 0
  const fetchMock = async (input: RequestInfo | URL): Promise<Response> => {
    if (String(input).includes('/jobToken/exchange')) {
      exchangeCalls++
      await new Promise(resolve => setTimeout(resolve, 20))
      return new Response(JSON.stringify({ token: 'jt-shared', expires_in: 3_600_000 }))
    }
    return new Response(JSON.stringify({ id: 'user-shared' }))
  }
  const service = new QoderAuthService({
    fetch: fetchMock as typeof fetch,
    resolveMachineId: () => 'machine-test',
  })
  const credentials = await Promise.all([
    service.getCredentials('pt-shared'),
    service.getCredentials('pt-shared'),
    service.getCredentials('pt-shared'),
  ])
  assert.equal(exchangeCalls, 1)
  assert.ok(credentials.every(value => value.authToken === 'jt-shared'))
})

test('QoderAuthService aborts a caller and the unobserved exchange', async () => {
  let providerAborted = false
  const fetchMock = (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => new Promise((_, reject) => {
    init?.signal?.addEventListener('abort', () => {
      providerAborted = true
      reject(new DOMException('aborted', 'AbortError'))
    }, { once: true })
  })
  const service = new QoderAuthService({ fetch: fetchMock as typeof fetch })
  const controller = new AbortController()
  const request = service.getCredentials('pt-abort', controller.signal)
  controller.abort()
  await assert.rejects(request, (error: Error) => {
    assert.ok(error instanceof QoderLlmError)
    assert.equal((error as QoderLlmError).code, 'ABORTED')
    return true
  })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(providerAborted, true)
})

test('QoderAuthService rejects missing identity without leaking provider bodies', async () => {
  const diagnostics: string[] = []
  const fetchMock = async (input: RequestInfo | URL): Promise<Response> => {
    if (String(input).includes('/jobToken/exchange')) {
      return new Response(JSON.stringify({ token: 'jt-secret', expires_in: 3_600_000 }))
    }
    return new Response(JSON.stringify({ email: 'secret@example.com', token: 'pt-secret' }))
  }
  const service = new QoderAuthService({
    fetch: fetchMock as typeof fetch,
    logger: {
      debug: (message, ...details) => diagnostics.push(JSON.stringify([message, ...details])),
      error: (message, ...details) => diagnostics.push(JSON.stringify([message, ...details])),
    },
  })
  await assert.rejects(service.getCredentials('pt-secret'), (error: Error) => {
    assert.ok(error instanceof QoderLlmError)
    assert.equal((error as QoderLlmError).code, 'AUTH')
    assert.ok(!error.message.includes('pt-secret'))
    assert.ok(!error.message.includes('secret@example.com'))
    return true
  })
  assert.doesNotMatch(diagnostics.join('\n'), /pt-secret|secret@example\.com/)
  assert.match(diagnostics.join('\n'), /auth\.exchange/)
  assert.match(diagnostics.join('\n'), /auth\.user-info/)
})

test('QoderAuthService targets region-specific OpenAPI endpoints and caches separately', async () => {
  const requests: string[] = []
  const fetchMock = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input)
    requests.push(url)
    if (url.includes('/jobToken/exchange')) {
      const isChina = url.includes('openapi.qoder.com.cn')
      return new Response(JSON.stringify({
        token: isChina ? 'jt-china' : 'jt-global',
        expires_in: 3_600_000,
      }))
    }
    if (url.includes('/userinfo')) {
      const isChina = url.includes('openapi.qoder.com.cn')
      return new Response(JSON.stringify({
        id: isChina ? 'user-cn' : 'user-global',
        name: isChina ? 'CN User' : 'Global User',
      }))
    }
    throw new Error(`unexpected URL: ${url}`)
  }
  const globalService = new QoderAuthService({
    fetch: fetchMock as typeof fetch,
    resolveMachineId: () => 'machine-test',
    region: 'global',
  })
  const chinaService = new QoderAuthService({
    fetch: fetchMock as typeof fetch,
    resolveMachineId: () => 'machine-test',
    region: 'china',
  })

  const globalCreds = await globalService.getCredentials('pt-test')
  assert.equal(globalCreds.authToken, 'jt-global')
  assert.equal(globalCreds.userID, 'user-global')
  assert.ok(requests.some(url => url.includes('openapi.qoder.sh/api/v1/jobToken/exchange')))

  const chinaCreds = await chinaService.getCredentials('pt-test')
  assert.equal(chinaCreds.authToken, 'jt-china')
  assert.equal(chinaCreds.userID, 'user-cn')
  assert.ok(requests.some(url => url.includes('openapi.qoder.com.cn/api/v1/jobToken/exchange')))
})

test('QoderAuthService classifies malformed exchange JSON as a protocol failure', async () => {
  const service = new QoderAuthService({
    fetch: (async () => new Response('{')) as typeof fetch,
  })
  await assert.rejects(service.getCredentials('pt-malformed'), (error: Error) => (
    error instanceof QoderLlmError && error.code === 'MALFORMED_RESPONSE'
  ))
})


test('job token expiry accepts CLI seconds, milliseconds and absolute timestamps', () => {
  const now = Date.parse('2026-10-01T00:00:00Z')
  for (const expires_in of [3600, 3_600_000]) {
    assert.equal(jobTokenExpiry({ expires_in }, now), now + 3_600_000)
  }
  for (const expires_at of ['2026-10-01T01:00:00Z', (now + 3_600_000) / 1000, now + 3_600_000]) {
    assert.equal(jobTokenExpiry({ expires_at, expires_in: 1 }, now), now + 3_600_000)
  }
  assert.equal(jobTokenExpiry({ expireTime: (now + 3_600_000) / 1000 }, now), now + 3_600_000)
  assert.equal(jobTokenExpiry({ expires_at: 'invalid', expires_in: 3600 }, now), now + 3_600_000)
  for (const expires_in of [NaN, Infinity, -1]) {
    assert.equal(jobTokenExpiry({ expires_in }, now), now + 86_400_000)
  }
})

test('second-based job tokens remain cached and device binding precedes exchange', async () => {
  let exchanges = 0
  let resolved = false
  const service = new QoderAuthService({
    resolveMachineId: () => { resolved = true; return 'offline-machine' },
    fetch: (async (input, init) => {
      if (String(input).includes('/exchange')) {
        assert.equal(resolved, true)
        assert.deepEqual(JSON.parse(String(init?.body)), { personal_token: 'pt-offline', machine_id: 'offline-machine' })
        exchanges++
        return new Response(JSON.stringify({ token: 'jt-offline', expires_in: 3600 }))
      }
      return new Response(JSON.stringify({ id: 'offline-user' }))
    }) as typeof fetch,
  })
  assert.equal(await service.getCredentials('pt-offline'), await service.getCredentials('pt-offline'))
  assert.equal(exchanges, 1)
})

test('authentication preserves organization context and reads organization tags from Open API', async () => {
  const requests: string[] = []
  const service = new QoderAuthService({
    region: 'china',
    resolveMachineId: () => 'offline-machine',
    fetch: (async (input, init) => {
      const url = String(input)
      requests.push(url)
      if (url.includes('/exchange')) return new Response(JSON.stringify({ device_token: 'jt-offline' }))
      if (url.includes('/userinfo')) return new Response(JSON.stringify({
        user_id: 'offline-user', organization: { org_id: 'org/offline' }, data_policy_agreed: false,
      }))
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer jt-offline')
      return new Response(JSON.stringify({ tags: ['Security', 42, 'JadeKey'] }))
    }) as typeof fetch,
  })
  const credentials = await service.getCredentials('pt-offline')
  assert.equal(credentials.organizationId, 'org/offline')
  assert.deepEqual(credentials.organizationTags, ['Security', 'JadeKey'])
  assert.equal(credentials.dataPolicyAgreed, false)
  assert.equal(requests[2], 'https://openapi.qoder.com.cn/api/v1/organizations/org%2Foffline/tags')
})

test('authentication retains organization when optional tag lookup fails', async () => {
  const service = new QoderAuthService({
    resolveMachineId: () => 'offline-machine',
    fetch: (async input => {
      const url = String(input)
      if (url.includes('/exchange')) return new Response(JSON.stringify({ token: 'jt-offline' }))
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'offline-user', orgId: 'org-offline' }))
      return new Response('', { status: 403 })
    }) as typeof fetch,
  })
  const credentials = await service.getCredentials('pt-offline')
  assert.equal(credentials.organizationId, 'org-offline')
  assert.equal(credentials.organizationTags, undefined)
})
