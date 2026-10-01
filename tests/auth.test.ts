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


function pendingTagResponse(signal: AbortSignal, onAbort: () => void): Promise<Response> {
  // Keep the mock I/O alive: AbortSignal.timeout itself does not keep Node alive.
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(new Response(JSON.stringify({ tags: ['late'] }))), 1000)
    const aborted = (): void => {
      clearTimeout(timer)
      onAbort()
      reject(new DOMException('aborted', 'AbortError'))
    }
    if (signal.aborted) aborted()
    else signal.addEventListener('abort', aborted, { once: true })
  })
}

test('stalled optional organization tags use an independent budget and cache core credentials', async () => {
  let exchanges = 0
  let tagCalls = 0
  let tagsAborted = false
  const service = new QoderAuthService({
    timeoutMs: 40,
    organizationTagsTimeoutMs: 80,
    resolveMachineId: () => 'offline-machine',
    fetch: (async (input, init) => {
      const url = String(input)
      if (url.includes('/exchange')) {
        exchanges++
        return new Response(JSON.stringify({ token: 'jt-offline' }))
      }
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'offline-user', orgId: 'offline-org' }))
      tagCalls++
      return pendingTagResponse(init!.signal!, () => { tagsAborted = true })
    }) as typeof fetch,
  })
  const credentials = await service.getCredentials('pt-offline')
  assert.equal(credentials.authToken, 'jt-offline')
  assert.equal(credentials.organizationId, 'offline-org')
  assert.equal(credentials.organizationTags, undefined)
  assert.equal(tagsAborted, true)
  assert.equal(await service.getCredentials('pt-offline'), credentials)
  assert.equal(exchanges, 1)
  assert.equal(tagCalls, 1)
})

test('optional organization tags may complete after the required authentication deadline', async () => {
  const service = new QoderAuthService({
    timeoutMs: 40,
    organizationTagsTimeoutMs: 300,
    resolveMachineId: () => 'offline-machine',
    fetch: (async (input, init) => {
      const url = String(input)
      if (url.includes('/exchange')) return new Response(JSON.stringify({ token: 'jt-offline' }))
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'offline-user', orgId: 'offline-org' }))
      await new Promise(resolve => setTimeout(resolve, 80))
      assert.equal(init?.signal?.aborted, false)
      return new Response(JSON.stringify({ tags: ['Security'] }))
    }) as typeof fetch,
  })
  const credentials = await service.getCredentials('pt-offline')
  assert.deepEqual(credentials.organizationTags, ['Security'])
})

test('optional organization tag budget includes metadata retry backoff', async () => {
  let tags = 0
  // Hold the event loop while the independent, unref-ed deadline ends retry backoff.
  const keepAlive = setTimeout(() => {}, 1000)
  try {
    const service = new QoderAuthService({
      timeoutMs: 40,
      organizationTagsTimeoutMs: 20,
      resolveMachineId: () => 'offline-machine',
      fetch: (async input => {
        const url = String(input)
        if (url.includes('/exchange')) return new Response(JSON.stringify({ token: 'jt-offline' }))
        if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'offline-user', orgId: 'offline-org' }))
        tags++
        return new Response('', { status: 503 })
      }) as typeof fetch,
    })
    const credentials = await service.getCredentials('pt-offline')
    assert.equal(credentials.organizationId, 'offline-org')
    assert.equal(credentials.organizationTags, undefined)
    assert.equal(tags, 1)
  } finally {
    clearTimeout(keepAlive)
  }
})

test('caller cancellation aborts optional tags and does not cache the cancelled authentication', async () => {
  let exchanges = 0
  let stallTags = true
  let tagsAborted = false
  let notifyTags!: () => void
  const tagsStarted = new Promise<void>(resolve => { notifyTags = resolve })
  const service = new QoderAuthService({
    timeoutMs: 100,
    organizationTagsTimeoutMs: 500,
    resolveMachineId: () => 'offline-machine',
    fetch: (async (input, init) => {
      const url = String(input)
      if (url.includes('/exchange')) {
        exchanges++
        return new Response(JSON.stringify({ token: 'jt-offline' }))
      }
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'offline-user', orgId: 'offline-org' }))
      if (!stallTags) return new Response(JSON.stringify({ tags: ['Security'] }))
      notifyTags()
      return pendingTagResponse(init!.signal!, () => { tagsAborted = true })
    }) as typeof fetch,
  })
  const caller = new AbortController()
  const flight = service.getCredentials('pt-offline', caller.signal)
  const rejection = assert.rejects(flight, (error: Error) => error instanceof QoderLlmError && error.code === 'ABORTED')
  await tagsStarted
  caller.abort()
  await rejection
  assert.equal(tagsAborted, true)
  stallTags = false
  assert.deepEqual((await service.getCredentials('pt-offline')).organizationTags, ['Security'])
  assert.equal(exchanges, 2)
})

test('one cancelled waiter does not abort organization tags needed by another waiter', async () => {
  let tagsAborted = false
  let finishTags!: (response: Response) => void
  let notifyTags!: () => void
  const tagsStarted = new Promise<void>(resolve => { notifyTags = resolve })
  const service = new QoderAuthService({
    timeoutMs: 100,
    organizationTagsTimeoutMs: 500,
    resolveMachineId: () => 'offline-machine',
    fetch: (async (input, init) => {
      const url = String(input)
      if (url.includes('/exchange')) return new Response(JSON.stringify({ token: 'jt-offline' }))
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'offline-user', orgId: 'offline-org' }))
      init?.signal?.addEventListener('abort', () => { tagsAborted = true }, { once: true })
      notifyTags()
      return new Promise<Response>(resolve => { finishTags = resolve })
    }) as typeof fetch,
  })
  const caller = new AbortController()
  const first = service.getCredentials('pt-offline', caller.signal)
  const rejection = assert.rejects(first, (error: Error) => error instanceof QoderLlmError && error.code === 'ABORTED')
  const second = service.getCredentials('pt-offline')
  await tagsStarted
  caller.abort()
  await rejection
  assert.equal(tagsAborted, false)
  finishTags(new Response(JSON.stringify({ tags: ['Security'] })))
  assert.deepEqual((await second).organizationTags, ['Security'])
})

test('a stalled required identity lookup still respects the authentication deadline', async () => {
  const service = new QoderAuthService({
    timeoutMs: 20,
    organizationTagsTimeoutMs: 500,
    resolveMachineId: () => 'offline-machine',
    fetch: (async (input, init) => {
      if (String(input).includes('/exchange')) return new Response(JSON.stringify({ token: 'jt-offline' }))
      return pendingTagResponse(init!.signal!, () => {})
    }) as typeof fetch,
  })
  await assert.rejects(service.getCredentials('pt-offline'), QoderLlmError)
})


test('synchronous caller cancellation while starting an exchange observes the shared rejection', async () => {
  const caller = new AbortController()
  const service = new QoderAuthService({
    resolveMachineId: () => 'offline-machine',
    fetch: (async () => {
      caller.abort()
      return new Response(JSON.stringify({ token: 'jt-offline' }))
    }) as typeof fetch,
  })
  await assert.rejects(service.getCredentials('pt-offline', caller.signal),
    (error: Error) => error instanceof QoderLlmError && error.code === 'ABORTED')
  // Let the abandoned shared exchange settle; the runner detects unhandled rejections.
  await new Promise(resolve => setTimeout(resolve, 0))
})
