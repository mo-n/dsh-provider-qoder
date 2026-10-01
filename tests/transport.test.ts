import test from 'node:test'
import assert from 'node:assert/strict'
import { createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { QoderLlmError } from '../src/qoder/errors.ts'
import { createQoderTransport } from '../src/qoder/transport/index.ts'

const catalog = JSON.stringify({ assistant: [{ key: 'cmodel', enable: true, display_name: 'Cantus' }] })

test('QoderTransport shares concurrent model discovery', async () => {
  let catalogCalls = 0
  const transport = createQoderTransport({
    region: 'global',
    resolvePat: () => Promise.resolve('pt-shared'),
    resolveMachineId: () => 'machine-test',
    fetch: (async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input)
      if (url.includes('/jobToken/exchange')) return new Response(JSON.stringify({ token: 'jt-shared' }))
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'user-shared' }))
      if (url.includes('/model/list')) {
        catalogCalls++
        await new Promise(resolve => setTimeout(resolve, 5))
        return new Response(catalog)
      }
      throw new Error(`unexpected URL: ${url}`)
    }) as typeof fetch,
  })

  const [first, second] = await Promise.all([
    transport.discoverModels(),
    transport.discoverModels(),
  ])
  assert.equal(catalogCalls, 1)
  assert.equal(first, second)
})

test('QoderTransport retries an idempotent model discovery once', async () => {
  let catalogCalls = 0
  const transport = createQoderTransport({
    region: 'global',
    resolvePat: () => Promise.resolve('pt-retry'),
    resolveMachineId: () => 'machine-test',
    fetch: (async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input)
      if (url.includes('/jobToken/exchange')) return new Response(JSON.stringify({ token: 'jt-retry' }))
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'user-retry' }))
      if (url.includes('/model/list')) {
        catalogCalls++
        return catalogCalls === 1 ? new Response('', { status: 503 }) : new Response(catalog)
      }
      throw new Error(`unexpected URL: ${url}`)
    }) as typeof fetch,
  })

  const models = await transport.discoverModels()
  assert.equal(catalogCalls, 2)
  assert.equal(models[0]?.id, 'cmodel')
})

test('QoderTransport aborts a shared discovery only after its last waiter leaves', async () => {
  let stallCatalog = false
  let upstreamAborted = false
  let notifyStarted: (() => void) | undefined
  const started = new Promise<void>(resolve => { notifyStarted = resolve })
  const transport = createQoderTransport({
    region: 'global',
    resolvePat: () => Promise.resolve('pt-shared'),
    resolveMachineId: () => 'machine-test',
    fetch: (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      if (url.includes('/jobToken/exchange')) return new Response(JSON.stringify({ token: 'jt-shared' }))
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'user-shared' }))
      if (url.includes('/model/list') && !stallCatalog) return new Response(catalog)
      if (url.includes('/model/list')) {
        notifyStarted?.()
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            upstreamAborted = true
            reject(new DOMException('aborted', 'AbortError'))
          }, { once: true })
        })
      }
      throw new Error(`unexpected URL: ${url}`)
    }) as typeof fetch,
  })

  await transport.discoverModels()
  stallCatalog = true
  const firstController = new AbortController()
  const secondController = new AbortController()
  const first = transport.discoverModels(firstController.signal)
  const second = transport.discoverModels(secondController.signal)
  await started

  firstController.abort()
  await assert.rejects(first, (error: Error) => error instanceof QoderLlmError && error.code === 'ABORTED')
  assert.equal(upstreamAborted, false)

  secondController.abort()
  await assert.rejects(second, (error: Error) => error instanceof QoderLlmError && error.code === 'ABORTED')
  assert.equal(upstreamAborted, true)
})

test('QoderTransport separates response-header timeout from stream idle timeout', async () => {
  const transport = createQoderTransport({
    region: 'global',
    resolvePat: () => Promise.resolve('pt-timeout'),
    resolveMachineId: () => 'machine-test',
    responseHeaderTimeoutMs: 5,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      if (url.includes('/jobToken/exchange')) return new Response(JSON.stringify({ token: 'jt-timeout' }))
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'user-timeout' }))
      if (url.includes('/agent_chat_generation')) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('timeout', 'AbortError')), { once: true })
        })
      }
      throw new Error(`unexpected URL: ${url}`)
    }) as typeof fetch,
  })
  const request: GenerateOptions = {
    provider: 'dsh-provider-qoder',
    model: 'cmodel',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'Hello' }], source: { kind: 'user' } })],
  }

  await assert.rejects(async () => {
    for await (const _chunk of transport.stream(request)) continue
  }, (error: Error) => (
    error instanceof QoderLlmError
    && error.code === 'TIMEOUT'
    && /response header/u.test(error.message)
  ))
})

const visionModel = {
  id: 'cmodel',
  name: 'Cantus Vision',
  supportsImages: true,
}

const imageRef = {
  attachmentId: 'sha256:image-1' as never,
  mediaType: 'image/png' as const,
  bytes: 3,
  width: 1,
  height: 1,
}

function transportAttachments() {
  return {
    imageLimits: {
      maxImageBytes: 5 * 1024 * 1024,
      maxImagesPerMessage: 20,
      maxMessageImageBytes: 100 * 1024 * 1024,
      maxImagePixels: 40_000_000,
      maxImageDimension: 2_000,
      mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const,
    },
    async readImageRequest(attachment: unknown) {
      return {
        variantId: 'sha256:variant-1',
        attachment,
        data: new Uint8Array([1, 2, 3]),
        mediaType: 'image/png',
        bytes: 3,
        width: 1,
        height: 1,
        depth: 'uchar',
        space: 'srgb',
        hasAlpha: true,
      }
    },
  } as never
}

function imageRequest(): GenerateOptions {
  return {
    provider: 'dsh-provider-qoder',
    model: 'cmodel',
    messages: [createUserMessage({
      content: [{ type: 'text', text: 'Look' }, { type: 'image', attachment: imageRef }],
      source: { kind: 'user' },
    })],
  } as GenerateOptions
}

test('QoderTransport publishes images to the center service before streaming', async () => {
  let uploads = 0
  let chatBody = ''
  const transport = createQoderTransport({
    region: 'global',
    resolvePat: () => Promise.resolve('pt-image'),
    resolveMachineId: () => 'machine-test',
    attachments: transportAttachments(),
    fetch: (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      if (url.includes('/jobToken/exchange')) return new Response(JSON.stringify({ token: 'jt-image' }))
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'user-image' }))
      if (url.includes('/image/upload')) {
        uploads++
        return new Response(JSON.stringify({ result: { oss_url: 'https://oss.qoder.sh/x.png' } }))
      }
      if (url.includes('/agent_chat_generation')) {
        chatBody = String(init?.body ?? '')
        return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
      }
      throw new Error(`unexpected URL: ${url}`)
    }) as typeof fetch,
  })

  for await (const _chunk of transport.stream(imageRequest(), visionModel)) continue
  assert.equal(uploads, 1)
  // The chat body is WAF-encoded, so assert on size: an inlined base64 image
  // would make it far larger than a short published URL.
  assert.ok(chatBody.length > 0)
  assert.ok(chatBody.length < 4_000, `chat body unexpectedly large: ${chatBody.length}`)
})

test('QoderTransport rejects images for a non-vision model before authenticating', async () => {
  let patCalls = 0
  let fetchCalls = 0
  const transport = createQoderTransport({
    region: 'global',
    resolvePat: () => {
      patCalls++
      return Promise.resolve('pt-none')
    },
    resolveMachineId: () => 'machine-test',
    attachments: transportAttachments(),
    fetch: (async (): Promise<Response> => {
      fetchCalls++
      return new Response('{}')
    }) as typeof fetch,
  })

  await assert.rejects(async () => {
    for await (const _chunk of transport.stream(imageRequest(), { id: 'cmodel', name: 'Text only' })) continue
  }, (error: Error) => (
    error instanceof QoderLlmError && error.code === 'UNSUPPORTED_CONTENT'
  ))
  assert.equal(patCalls, 0)
  assert.equal(fetchCalls, 0)
})

test('QoderTransport still streams when center image publication fails', async () => {
  let chatCalls = 0
  const transport = createQoderTransport({
    region: 'global',
    resolvePat: () => Promise.resolve('pt-degrade'),
    resolveMachineId: () => 'machine-test',
    attachments: transportAttachments(),
    logger: { warn: () => {} },
    fetch: (async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input)
      if (url.includes('/jobToken/exchange')) return new Response(JSON.stringify({ token: 'jt-degrade' }))
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'user-degrade' }))
      if (url.includes('/image/upload')) return new Response('', { status: 500 })
      if (url.includes('/agent_chat_generation')) {
        chatCalls++
        return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
      }
      throw new Error(`unexpected URL: ${url}`)
    }) as typeof fetch,
  })

  for await (const _chunk of transport.stream(imageRequest(), visionModel)) continue
  assert.equal(chatCalls, 1)
})

test('QoderTransport signs chat with the job token refreshed during image publication', async () => {
  let exchanges = 0
  let uploads = 0
  let chatUser = ''
  const transport = createQoderTransport({
    region: 'global',
    resolvePat: async () => 'pt-refresh',
    resolveMachineId: () => 'machine-test',
    attachments: transportAttachments(),
    fetch: (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      if (url.includes('/jobToken/exchange')) {
        exchanges++
        return new Response(JSON.stringify({ token: `jt-${exchanges}` }))
      }
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: `user-${exchanges}` }))
      if (url.includes('/image/upload')) {
        uploads++
        return uploads === 1
          ? new Response('', { status: 401 })
          : new Response(JSON.stringify({ url: 'https://oss.qoder.sh/x.png' }))
      }
      if (url.includes('/agent_chat_generation')) {
        chatUser = new Headers(init?.headers).get('Cosy-User')!
        return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
      }
      throw new Error(`unexpected URL: ${url}`)
    }) as typeof fetch,
  })

  for await (const _chunk of transport.stream(imageRequest(), visionModel)) continue
  assert.equal(exchanges, 2)
  assert.equal(uploads, 2)
  assert.equal(chatUser, 'user-2')
})


function textRequest(): GenerateOptions {
  return { provider: 'dsh-provider-qoder', model: 'cmodel', sessionId: 'offline-session' as GenerateOptions['sessionId'], messages: [
    createUserMessage({ content: [{ type: 'text', text: 'Offline request' }], source: { kind: 'user' } }),
  ] }
}

async function collectStream(transport: ReturnType<typeof createQoderTransport>) {
  for await (const _chunk of transport.stream(textRequest())) continue
}

for (const status of [401, 403]) {
  test(`model HTTP ${status} refreshes once and preserves the prepared request identity`, async () => {
    let exchanges = 0
    const bodies: string[] = []
    const authorizations: string[] = []
    const transport = createQoderTransport({
      region: 'global', resolvePat: async () => 'pt-offline', resolveMachineId: () => 'offline-machine',
      fetch: (async (input, init) => {
        const url = String(input)
        if (url.includes('/exchange')) return new Response(JSON.stringify({ token: `jt-offline-${++exchanges}` }))
        if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'offline-user' }))
        bodies.push(String(init?.body))
        authorizations.push(new Headers(init?.headers).get('authorization')!)
        return bodies.length === 1 ? new Response('{"code":"expired"}', { status })
          : new Response('data: [DONE]\n\n')
      }) as typeof fetch,
    })
    await collectStream(transport)
    assert.equal(exchanges, 2)
    assert.equal(bodies.length, 2)
    assert.equal(bodies[0], bodies[1])
    assert.notEqual(authorizations[0], authorizations[1])
  })
}

for (const [status, body, attempts] of [
  [403, '{"code":103}', 1], [429, 'limited', 1], [503, 'unavailable', 1], [401, 'expired', 2],
] as const) {
  test(`model rejection ${status}/${body} has bounded authentication recovery`, async () => {
    let exchanges = 0
    let chats = 0
    const transport = createQoderTransport({
      region: 'global', resolvePat: async () => 'pt-offline', resolveMachineId: () => 'offline-machine',
      fetch: (async input => {
        const url = String(input)
        if (url.includes('/exchange')) return new Response(JSON.stringify({ token: `jt-offline-${++exchanges}` }))
        if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'offline-user' }))
        chats++
        return new Response(body, { status })
      }) as typeof fetch,
    })
    await assert.rejects(() => collectStream(transport), QoderLlmError)
    assert.equal(chats, attempts)
    assert.equal(exchanges, attempts)
  })
}

test('model HTTP success with later SSE authentication error is never replayed', async () => {
  let chats = 0
  let exchanges = 0
  const transport = createQoderTransport({
    region: 'global', resolvePat: async () => 'pt-offline', resolveMachineId: () => 'offline-machine',
    fetch: (async input => {
      const url = String(input)
      if (url.includes('/exchange')) return new Response(JSON.stringify({ token: `jt-offline-${++exchanges}` }))
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'offline-user' }))
      chats++
      return new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\ndata: {"statusCodeValue":401,"body":"expired"}\n\n')
    }) as typeof fetch,
  })
  await assert.rejects(() => collectStream(transport), QoderLlmError)
  assert.equal(chats, 1)
  assert.equal(exchanges, 1)
})

test('subscriber changes during authentication recovery do not resend the old request', async () => {
  let exchanges = 0
  let chats = 0
  const transport = createQoderTransport({
    region: 'global', resolvePat: async () => 'pt-offline', resolveMachineId: () => 'offline-machine',
    fetch: (async input => {
      const url = String(input)
      if (url.includes('/exchange')) return new Response(JSON.stringify({ token: `jt-offline-${++exchanges}` }))
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: `offline-user-${exchanges}` }))
      chats++
      return new Response('expired', { status: 401 })
    }) as typeof fetch,
  })
  await assert.rejects(() => collectStream(transport), /identity changed/)
  assert.equal(chats, 1)
})

test('caller cancellation during credential refresh prevents a model replay', async () => {
  const controller = new AbortController()
  let exchanges = 0
  let chats = 0
  const transport = createQoderTransport({
    region: 'global', resolvePat: async () => 'pt-offline', resolveMachineId: () => 'offline-machine',
    fetch: (async input => {
      const url = String(input)
      if (url.includes('/exchange')) {
        exchanges++
        if (exchanges === 2) controller.abort()
        return new Response(JSON.stringify({ token: `jt-offline-${exchanges}` }))
      }
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'offline-user' }))
      chats++
      return new Response('expired', { status: 401 })
    }) as typeof fetch,
  })
  await assert.rejects(async () => {
    for await (const _chunk of transport.stream({ ...textRequest(), signal: controller.signal })) continue
  }, (error: Error) => error instanceof QoderLlmError && error.code === 'ABORTED')
  assert.equal(chats, 1)
})

for (const bodyFailure of ['oversized', 'interrupted'] as const) {
  for (const [status, code] of [[401, 'AUTH'], [403, 'AUTH'], [429, 'RATE_LIMIT'], [503, 'SERVER']] as const) {
    test(`HTTP ${status} retains recovery and error metadata with ${bodyFailure} diagnostics`, async () => {
      let exchanges = 0
      const bodies: string[] = []
      const transport = createQoderTransport({
        region: 'global', resolvePat: async () => 'pt-offline', resolveMachineId: () => 'offline-machine',
        fetch: (async (input, init) => {
          const url = String(input)
          if (url.includes('/exchange')) return new Response(JSON.stringify({ token: `jt-${++exchanges}` }))
          if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'offline-user' }))
          bodies.push(String(init?.body))
          const body = bodyFailure === 'oversized' ? 'x'.repeat(16 * 1024 + 1)
            : new ReadableStream({ start(controller) { controller.error(new Error('connection reset')) } })
          return new Response(body, { status, headers: { 'retry-after': '60', 'x-request-id': 'upstream-id' } })
        }) as typeof fetch,
      })
      await assert.rejects(() => collectStream(transport), (error: unknown) => {
        assert.ok(error instanceof QoderLlmError)
        assert.equal(error.code, code)
        assert.equal(error.failure.status, status)
        assert.equal(error.failure.providerRetryAfterMs, 60_000)
        assert.equal(error.failure.requestId, 'upstream-id')
        return true
      })
      const attempts = code === 'AUTH' ? 2 : 1
      assert.equal(exchanges, attempts)
      assert.equal(bodies.length, attempts)
      if (attempts === 2) assert.equal(bodies[0], bodies[1])
    })
  }
}

for (const cancellation of ['caller', 'timeout'] as const) {
  test(`${cancellation} cancellation while reading authentication diagnostics prevents recovery`, async () => {
    const caller = new AbortController()
    let exchanges = 0
    let chats = 0
    const transport = createQoderTransport({
      region: 'global', resolvePat: async () => 'pt-offline', resolveMachineId: () => 'offline-machine',
      streamIdleTimeoutMs: 10,
      fetch: (async (input, init) => {
        const url = String(input)
        if (url.includes('/exchange')) return new Response(JSON.stringify({ token: `jt-${++exchanges}` }))
        if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'offline-user' }))
        chats++
        return new Response(new ReadableStream({
          start(controller) {
            init!.signal!.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')), { once: true })
            if (cancellation === 'caller') caller.abort()
          },
        }), { status: 401 })
      }) as typeof fetch,
    })
    await assert.rejects(async () => {
      for await (const _chunk of transport.stream({ ...textRequest(), signal: caller.signal })) continue
    }, (error: unknown) => error instanceof QoderLlmError && error.code === (cancellation === 'caller' ? 'ABORTED' : 'TIMEOUT'))
    assert.equal(chats, 1)
    assert.equal(exchanges, 1)
  })
}
