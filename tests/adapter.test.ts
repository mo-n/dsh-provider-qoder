import test from 'node:test'
import assert from 'node:assert/strict'
import { createUserMessage, LlmAdapter, LlmError, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { QoderAdapter } from '../src/dsh/adapter.ts'
import { QODER_PROVIDER_ID } from '../src/dsh/provider.ts'
import type { QoderCatalogModel } from '../src/qoder/catalog.ts'
import { QoderLlmError } from '../src/qoder/errors.ts'
import { createQoderTransport, type QoderTransportOptions } from '../src/qoder/transport/index.ts'

import type { QoderAdapterOptions } from '../src/dsh/adapter.ts'

interface TestAdapterOptions extends Omit<QoderTransportOptions, 'region'> {
  region?: QoderTransportOptions['region']
  models?: readonly QoderCatalogModel[]
  sessions?: QoderAdapterOptions['sessions']
  agents?: QoderAdapterOptions['agents']
}

function testAdapter(options: TestAdapterOptions): QoderAdapter {
  const { models, sessions, agents, ...transportOptions } = options
  const transport = createQoderTransport({
    ...transportOptions,
    region: options.region ?? 'global',
  })
  return new QoderAdapter({
    resolveTransport: () => transport,
    region: () => options.region ?? 'global',
    models,
    sessions,
    agents,
  })
}

function request(signal?: AbortSignal): GenerateOptions {
  return {
    provider: QODER_PROVIDER_ID,
    model: 'cmodel',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'Hello' }], source: { kind: 'user' } })],
    signal,
  }
}

function successfulFetch(assertChat?: (init?: RequestInit) => void): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    if (url.includes('/jobToken/exchange')) {
      return new Response(JSON.stringify({ token: 'jt-token', expires_in: 3_600_000 }))
    }
    if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'user-42' }))
    assertChat?.(init)
    const inner = JSON.stringify({ choices: [{ delta: { content: 'Qoder response' } }] })
    return new Response([
      `data: ${JSON.stringify({ statusCodeValue: 200, body: inner })}`,
      'data: [DONE]',
      '',
    ].join('\n'))
  }) as typeof fetch
}

test('QoderAdapter implements the real DSH adapter and model contracts', async () => {
  const adapter = testAdapter({ resolvePat: () => Promise.resolve('pt-token'), fetch: successfulFetch() })
  assert.ok(adapter instanceof LlmAdapter)
  assert.equal(adapter.providerRetryPolicy(QODER_PROVIDER_ID), undefined)
  assert.equal(adapter.providerInfo(QODER_PROVIDER_ID).id, QODER_PROVIDER_ID)
  const models = await adapter.listModels(QODER_PROVIDER_ID)
  const modelIds = models.map(model => model.id)
  assert.ok(modelIds.length > 1)
  assert.ok(modelIds.includes('cmodel'))
  assert.ok(modelIds.includes('auto'))
  assert.ok(modelIds.includes('ultimate'))
  assert.deepEqual(models.find(model => model.id === 'cmodel')?.inputModalities, ['text', 'image'])
  assert.deepEqual(models.find(model => model.id === 'lite')?.inputModalities, ['text'])
  assert.equal((await adapter.resolveModel(QODER_PROVIDER_ID, 'custom')).id, 'custom')
})

test('QoderAdapter resolves the PAT through its configured credential boundary', async () => {
  let resolvePatCalls = 0
  const adapter = testAdapter({
    resolvePat: () => {
      resolvePatCalls++
      return Promise.resolve('pt-token-from-resolver')
    },
    fetch: successfulFetch(),
  })
  for await (const _chunk of adapter.stream(request())) continue
  assert.equal(resolvePatCalls, 1)
})

test('QoderAdapter directs missing managed credentials to the Qoder settings page', async () => {
  let fetchCalls = 0
  const adapter = testAdapter({
    resolvePat: () => Promise.resolve(''),
    fetch: (async () => { fetchCalls++; throw new Error('must not fetch') }) as typeof fetch,
  })
  await assert.rejects(async () => {
    for await (const _chunk of adapter.stream(request())) continue
  }, (error: Error) => {
    assert.ok(error instanceof QoderLlmError)
    assert.equal((error as QoderLlmError).code, 'MISSING_CREDENTIAL')
    assert.match(error.message, /Qoder settings page/u)
    assert.doesNotMatch(error.message, /QODER_/u)
    return true
  })
  assert.equal(fetchCalls, 0)
})

test('QoderAdapter streams through DSH chunks and sends attribution', async () => {
  const adapter = testAdapter({
    resolvePat: () => Promise.resolve('pt-token'),
    fetch: successfulFetch((init) => {
      const headers = init?.headers as Record<string, string>
      assert.ok(headers.Authorization.startsWith('Bearer COSY.'))
      assert.match(headers['user-agent'], /deepseek-harness/)
      assert.equal(headers['x-model-key'], 'cmodel')
    }),
  })
  const chunks = []
  for await (const chunk of adapter.stream(request())) chunks.push(chunk)
  assert.deepEqual(chunks.map(chunk => chunk.type), ['block-start', 'text-delta', 'block-end', 'finish'])
})

test('QoderAdapter replaces its live model catalog and transport source', async () => {
  let source: string | undefined
  const adapter = testAdapter({
    resolvePat: () => Promise.resolve('pt-token'),
    fetch: successfulFetch((init) => { source = (init?.headers as Record<string, string>)['x-model-source'] }),
  })
  adapter.replaceModels([{ id: 'live', name: 'Live', source: 'subscriber', maxTokens: 2048 }])
  assert.deepEqual((await adapter.listModels(QODER_PROVIDER_ID)).map(model => model.id), ['live'])
  const options = request()
  options.model = 'live'
  for await (const _chunk of adapter.stream(options)) continue
  assert.equal(source, 'subscriber')
})

test('QoderAdapter resolves only explicitly advertised reasoning efforts', async () => {
  const adapter = testAdapter({
    resolvePat: () => Promise.resolve('pt-token'),
    models: [{
      id: 'reasoner',
      name: 'Reasoner',
      reasoningEfforts: [
        { id: 'low', name: 'low' },
        { id: 'high', name: 'high', description: 'Deep reasoning' },
      ],
      defaultReasoningEffort: 'high',
    }],
    fetch: successfulFetch(),
  })
  const resolved = await adapter.resolveModel(QODER_PROVIDER_ID, 'reasoner')
  assert.deepEqual(resolved.reasoning, {
    efforts: [
      { id: 'low', name: 'low' },
      { id: 'high', name: 'high', description: 'Deep reasoning' },
    ],
    defaultEffort: 'high',
  })
})

test('QoderAdapter appends the advertised price factor to model display names', async () => {
  const adapter = testAdapter({
    resolvePat: () => Promise.resolve('pt-token'),
    models: [
      { id: 'priced', name: 'Priced', priceFactor: 1.6 },
      { id: 'free', name: 'Free', priceFactor: 0 },
      { id: 'discounted', name: 'Discounted', priceFactor: 0.5, originalPriceFactor: 1 },
      { id: 'plain', name: 'Plain' },
    ],
    fetch: successfulFetch(),
  })

  assert.deepEqual((await adapter.listModels(QODER_PROVIDER_ID)).map(model => model.name), [
    'Priced （1.6x）',
    'Free （免费）',
    'Discounted （0.5x（原 1x））',
    'Plain',
  ])
  assert.equal((await adapter.resolveModel(QODER_PROVIDER_ID, 'priced')).name, 'Priced （1.6x）')
})

test('disabled reasoning does not expose an effort default that DSH would automatically select', async () => {
  const adapter = testAdapter({
    resolvePat: () => Promise.resolve('pt-token'),
    models: [{
      id: 'reasoner', name: 'Reasoner', isReasoning: false,
      reasoningEfforts: [{ id: 'high', name: 'high' }], defaultReasoningEffort: 'high',
    }],
    fetch: successfulFetch(),
  })
  const resolved = await adapter.resolveModel(QODER_PROVIDER_ID, 'reasoner')
  assert.deepEqual(resolved.reasoning, { efforts: [{ id: 'high', name: 'high' }] })
})

test('QoderAdapter rejects unsupported content before provider I/O', async () => {
  let fetchCalls = 0
  const adapter = testAdapter({
    resolvePat: () => Promise.resolve('pt-token'),
    fetch: (async () => { fetchCalls++; throw new Error('must not fetch') }) as typeof fetch,
  })
  const options = request()
  options.model = 'lite'
  options.messages = [createUserMessage({ content: [{ type: 'image' } as never], source: { kind: 'user' } })]
  await assert.rejects(async () => {
    for await (const _chunk of adapter.stream(options)) continue
  }, (error: Error) => {
    assert.ok(error instanceof QoderLlmError)
    assert.equal((error as QoderLlmError).code, 'UNSUPPORTED_CONTENT')
    return true
  })
  assert.equal(fetchCalls, 0)
})

test('QoderAdapter surfaces an unreadable image attachment without starting a model request', async () => {
  // Image publication must be able to sign with credentials, so attachment
  // reads now follow authentication (ADR-0004). An unreadable attachment still
  // fails the turn, and no chat request is ever issued.
  let chatCalls = 0
  const adapter = testAdapter({
    resolvePat: () => Promise.resolve('pt-token'),
    attachments: {
      imageLimits: {
        maxImageBytes: 5 * 1024 * 1024,
        maxImagesPerMessage: 20,
        maxMessageImageBytes: 100 * 1024 * 1024,
        maxImagePixels: 40_000_000,
        maxImageDimension: 2_000,
        mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
      },
      readImageRequest: async () => { throw new Error('missing attachment') },
    },
    fetch: (async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input)
      if (url.includes('/jobToken/exchange')) return new Response(JSON.stringify({ token: 'jt-token' }))
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'user-42' }))
      chatCalls++
      throw new Error('must not reach the model')
    }) as typeof fetch,
  })
  const options = request()
  options.messages = [createUserMessage({
    content: [{
      type: 'image',
      attachment: {
        attachmentId: 'sha256:missing' as never,
        mediaType: 'image/png',
        bytes: 3,
        width: 1,
        height: 1,
      },
    }],
    source: { kind: 'user' },
  })]

  await assert.rejects(async () => {
    for await (const _chunk of adapter.stream(options)) continue
  }, (error: Error) => error instanceof QoderLlmError && error.code === 'ATTACHMENT')
  assert.equal(chatCalls, 0)
})

test('QoderAdapter aborts an idle provider stream', async () => {
  const fetchMock = successfulFetch()
  const adapter = testAdapter({
    resolvePat: () => Promise.resolve('pt-token'),
    streamIdleTimeoutMs: 10,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (!String(input).includes('/agent_chat_generation')) return fetchMock(input, init)
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener('abort', () => {
            controller.error(new DOMException('aborted', 'AbortError'))
          }, { once: true })
        },
      }))
    }) as typeof fetch,
  })
  await assert.rejects(async () => {
    for await (const _chunk of adapter.stream(request())) continue
  }, (error: Error) => {
    assert.ok(error instanceof QoderLlmError)
    assert.equal((error as QoderLlmError).code, 'TIMEOUT')
    return true
  })
})

test('QoderAdapter logs stream failures through the host logger', async () => {
  const fetchMock = successfulFetch()
  const entries: unknown[][] = []
  const adapter = testAdapter({
    resolvePat: () => Promise.resolve('pt-token'),
    logger: {
      error(message, ...details) {
        entries.push([message, ...details])
      },
    },
    fetch: (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (!String(input).includes('/agent_chat_generation')) return fetchMock(input, init)
      return new Response('unavailable', { status: 503 })
    }) as typeof fetch,
  })

  await assert.rejects(async () => {
    for await (const _chunk of adapter.stream(request())) continue
  }, (error: Error) => {
    assert.ok(error instanceof QoderLlmError)
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, 'SERVER')
    assert.equal(error.failure.status, 503)
    return true
  })

  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.[0], '[Qoder Stream] Request failed')
  assert.match(JSON.stringify(entries[0]?.[1]), /SERVER/u)
})

test('QoderAdapter logs stream lifecycle metrics and diagnostics', async () => {
  const fetchMock = successfulFetch()
  const debugEntries: unknown[][] = []
  const adapter = testAdapter({
    resolvePat: () => Promise.resolve('pt-token'),
    logger: {
      debug(message, ...details) {
        debugEntries.push([message, ...details])
      },
    },
    fetch: fetchMock,
  })

  for await (const _chunk of adapter.stream(request())) continue

  const messages = debugEntries.map(entry => entry[0])
  assert.ok(messages.includes('[Qoder Stream] Response headers received'))
  assert.ok(messages.includes('[Qoder Stream] First chunk received'))
  assert.ok(messages.includes('[Qoder Stream] Stream completed'))

  const completed = debugEntries.find(entry => entry[0] === '[Qoder Stream] Stream completed') as Record<string, unknown>[]
  const payload = completed?.[1]
  assert.ok(typeof payload?.durationMs === 'number')
  assert.ok(typeof payload?.chunkCount === 'number' && payload.chunkCount > 0)
})

test('QoderAdapter maps rate limits and network failures to retryable DSH errors', async () => {
  const fetchMock = successfulFetch()
  const limited = testAdapter({
    resolvePat: () => Promise.resolve('pt-token'),
    fetch: (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (!String(input).includes('/agent_chat_generation')) return fetchMock(input, init)
      return new Response('slow down', { status: 429, headers: { 'Retry-After': '3' } })
    }) as typeof fetch,
  })
  await assert.rejects(async () => {
    for await (const _chunk of limited.stream(request())) continue
  }, (error: Error) => {
    assert.ok(error instanceof QoderLlmError)
    assert.equal(error.code, 'RATE_LIMIT')
    assert.equal(error.failure.status, 429)
    assert.equal(error.failure.providerRetryAfterMs, 3000)
    return true
  })

  const unavailable = testAdapter({
    resolvePat: () => Promise.resolve('pt-token'),
    fetch: (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (!String(input).includes('/agent_chat_generation')) return fetchMock(input, init)
      throw new TypeError('fetch failed')
    }) as typeof fetch,
  })
  await assert.rejects(async () => {
    for await (const _chunk of unavailable.stream(request())) continue
  }, (error: Error) => (
    error instanceof QoderLlmError
    && error.code === 'TRANSPORT'
    && error.cause instanceof TypeError
  ))
})

test('QoderAdapter does not log caller cancellation as a stream failure', async () => {
  const fetchMock = successfulFetch()
  const caller = new AbortController()
  const entries: unknown[][] = []
  const adapter = testAdapter({
    resolvePat: () => Promise.resolve('pt-token'),
    logger: { error: (...entry) => entries.push(entry) },
    fetch: (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (!String(input).includes('/agent_chat_generation')) return fetchMock(input, init)
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener('abort', () => {
            controller.error(new DOMException('aborted', 'AbortError'))
          }, { once: true })
        },
      })
      queueMicrotask(() => caller.abort())
      return new Response(body)
    }) as typeof fetch,
  })

  await assert.rejects(async () => {
    for await (const _chunk of adapter.stream(request(caller.signal))) continue
  }, (error: Error) => error instanceof QoderLlmError && error.code === 'ABORTED')
  assert.deepEqual(entries, [])
})

test('QoderAdapter routes chat streaming to the configured region endpoint', async () => {
  let targetUrl = ''
  const fetchMock = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    if (url.includes('/jobToken/exchange')) {
      return new Response(JSON.stringify({ token: 'jt-token', expires_in: 3_600_000 }))
    }
    if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'user-42' }))
    if (url.includes('/agent_chat_generation')) {
      targetUrl = url
      const inner = JSON.stringify({ choices: [{ delta: { content: 'OK' } }] })
      return new Response([
        `data: ${JSON.stringify({ statusCodeValue: 200, body: inner })}`,
        'data: [DONE]',
        '',
      ].join('\n'))
    }
    throw new Error(`unexpected URL: ${url}`)
  }
  const adapter = testAdapter({
    resolvePat: () => Promise.resolve('pt-token'),
    fetch: fetchMock as typeof fetch,
    region: 'china',
  })

  for await (const _chunk of adapter.stream(request())) continue
  assert.ok(targetUrl.startsWith('https://gateway.qoder.com.cn/'))

  const globalAdapter = testAdapter({
    resolvePat: () => Promise.resolve('pt-token'),
    fetch: fetchMock as typeof fetch,
    region: 'global',
  })
  for await (const _chunk of globalAdapter.stream(request())) continue
  assert.ok(targetUrl.startsWith('https://api3.qoder.sh/'))
})

test('QoderAdapter widens the resolved context window for an explicit tier selection', async () => {
  const adapter = testAdapter({
    resolvePat: () => Promise.resolve('pt-token'),
    models: [{
      id: 'tiered', name: 'Tiered', contextWindow: 200_000, contextTier: 'large',
      contextOptions: {
        small: { tokenCount: 200_000, isDefault: true },
        large: { tokenCount: 1_000_000 },
      },
    }],
    fetch: successfulFetch(),
  })

  const info = await adapter.resolveModel(QODER_PROVIDER_ID, 'tiered')
  assert.equal(info.context?.contextWindow, 1_000_000)
})

test('QoderAdapter honors manual session tier override over global default', async () => {
  const adapter = testAdapter({
    resolvePat: () => Promise.resolve('pt-token'),
    models: [{
      id: 'tiered', name: 'Tiered', contextWindow: 1_000_000, contextTier: 'large',
      contextOptions: {
        small: { tokenCount: 200_000, isDefault: true },
        large: { tokenCount: 1_000_000 },
      },
    }],
    agents: {
      currentInitiator: () => ({ session: { id: 'session-manual' } }),
    },
    fetch: successfulFetch(),
  })

  adapter.setSessionTier('session-manual', 'tiered', 'small')
  const info = await adapter.resolveModel(QODER_PROVIDER_ID, 'tiered')
  assert.equal(info.context?.contextWindow, 200_000)

  // Another session still resolves to global default (large / 1_000_000)
  const defaultModel = adapter.resolveEffectiveModelForSession('tiered', 'session-other')
  assert.equal(defaultModel?.contextTier, 'large')
  assert.equal(defaultModel?.contextWindow, 1_000_000)
})

test('QoderAdapter falls back to historical requestContext tier for old sessions', async () => {
  const adapter = testAdapter({
    resolvePat: () => Promise.resolve('pt-token'),
    models: [{
      id: 'tiered', name: 'Tiered', contextWindow: 1_000_000, contextTier: 'large',
      contextOptions: {
        small: { tokenCount: 200_000, isDefault: true },
        large: { tokenCount: 1_000_000 },
      },
    }],
    sessions: {
      get: (id: string) => {
        if (id === 'session-old') {
          return {
            requestContext: () => ({
              provider: QODER_PROVIDER_ID,
              model: 'tiered',
              contextWindow: 200_000,
            }),
          }
        }
        return undefined
      },
    },
    agents: {
      currentInitiator: () => ({ session: { id: 'session-old' } }),
    },
    fetch: successfulFetch(),
  })

  const info = await adapter.resolveModel(QODER_PROVIDER_ID, 'tiered')
  assert.equal(info.context?.contextWindow, 200_000)

  // In stream, options.sessionId resolves the historical tier
  const req: GenerateOptions = {
    ...request(),
    model: 'tiered',
    sessionId: 'session-old' as unknown as GenerateOptions['sessionId'],
  }
  let chatBody: string | undefined
  const fetchMock = successfulFetch((init) => {
    chatBody = String(init?.body)
  })
  const streamingAdapter = testAdapter({
    resolvePat: () => Promise.resolve('pt-token'),
    models: [{
      id: 'tiered', name: 'Tiered', contextWindow: 1_000_000, contextTier: 'large',
      contextOptions: {
        small: { tokenCount: 200_000, isDefault: true },
        large: { tokenCount: 1_000_000 },
      },
    }],
    sessions: {
      get: (id: string) => id === 'session-old' ? {
        requestContext: () => ({ provider: QODER_PROVIDER_ID, model: 'tiered', contextWindow: 200_000 }),
      } : undefined,
    },
    fetch: fetchMock,
  })

  const effective = streamingAdapter.resolveEffectiveModelForSession('tiered', 'session-old')
  assert.equal(effective?.contextTier, 'small')
  assert.equal(effective?.contextWindow, 200_000)
  for await (const _chunk of streamingAdapter.stream(req)) continue
  assert.ok(chatBody)
  assert.ok(chatBody.length > 0)
})

test('prepared requests keep their budget, model and transport when the next request changes', async () => {
  const models: QoderCatalogModel[] = [{ id: 'tiered', name: 'Tiered', contextWindow: 1_000_000, contextTier: 'large', contextOptions: {
    small: { tokenCount: 200_000, isDefault: true }, large: { tokenCount: 1_000_000 },
  } }]
  const sent: Array<{ region: string; budget?: number }> = []
  const makeTransport = (region: string) => ({
    stream: (_options: GenerateOptions, model?: QoderCatalogModel) => {
      sent.push({ region, budget: model?.contextWindow })
      return (async function* () {})()
    },
  }) as unknown as ReturnType<typeof createQoderTransport>
  let region: 'global' | 'china' = 'global'
  let transport = makeTransport(region)
  const adapter = new QoderAdapter({ models, region: () => region, resolveTransport: () => transport,
    agents: { currentInitiator: () => ({ session: { id: 's' } }) },
  })
  const prepared = await adapter.prepareCall(QODER_PROVIDER_ID, 'tiered')
  adapter.setSessionTier('s', 'tiered', 'small', 'global')
  const next = await adapter.prepareCall(QODER_PROVIDER_ID, 'tiered')
  region = 'china'
  transport = makeTransport(region)
  assert.equal(adapter.getSessionTier('s', 'tiered'), undefined)
  assert.equal(adapter.resolveEffectiveModelForSession('tiered', 's')?.contextWindow, 1_000_000)
  assert.throws(() => adapter.setSessionTier('s', 'tiered', 'small', 'global'))
  assert.throws(() => adapter.setSessionTier('s', 'tiered', 'missing', 'china'))
  const options = { ...request(), model: 'tiered' }
  for await (const _ of prepared.stream(options)) continue
  for await (const _ of next.stream(options)) continue
  assert.equal(prepared.model.context?.contextWindow, 1_000_000)
  assert.equal(next.model.context?.contextWindow, 200_000)
  assert.deepEqual(sent, [{ region: 'global', budget: 1_000_000 }, { region: 'global', budget: 200_000 }])
})

test('region changes never reinterpret unscoped historical capacity in another region', () => {
  let region: 'global' | 'china' = 'global'
  const model: QoderCatalogModel = { id: 'tiered', name: 'Tiered', contextWindow: 1_000_000, contextTier: 'large', contextOptions: {
    small: { tokenCount: 200_000 }, large: { tokenCount: 1_000_000, isDefault: true },
  } }
  const adapter = new QoderAdapter({
    models: [model], region: () => region,
    resolveTransport: () => ({} as ReturnType<typeof createQoderTransport>),
    sessions: { get: () => ({ requestContext: () => ({ provider: QODER_PROVIDER_ID, model: 'tiered', contextWindow: 200_000 }) }) },
  })
  assert.equal(adapter.resolveEffectiveModelForSession('tiered', 's')?.contextWindow, 200_000)
  adapter.setSessionTier('s', 'tiered', 'small')
  region = 'china'
  adapter.replaceModels([model])
  assert.equal(adapter.resolveEffectiveModelForSession('tiered', 's')?.contextWindow, 1_000_000)
  region = 'global'
  adapter.replaceModels([model])
  assert.equal(adapter.resolveEffectiveModelForSession('tiered', 's')?.contextWindow, 200_000)
})

test('request context diagnostics report the serialized tier before sending without private content', async () => {
  const entries: unknown[][] = []
  const adapter = testAdapter({
    resolvePat: () => Promise.resolve('pt-token'),
    region: 'china',
    models: [{ id: 'tiered', name: 'Tiered', contextWindow: 200_000, contextTier: 'large', contextOptions: {
      small: { tokenCount: 200_000, isDefault: true }, large: { tokenCount: 1_000_000 },
    } }],
    logger: { debug: (...entry) => { entries.push(entry) } },
    fetch: successfulFetch(() => {
      assert.ok(entries.some(entry => entry[0] === '[Qoder Stream] Request context'))
    }),
  })
  for await (const _ of adapter.stream({
    ...request(), model: 'tiered', sessionId: 'diagnostic-session' as GenerateOptions['sessionId'], purpose: 'session-title',
  })) continue
  const details = entries.find(entry => entry[0] === '[Qoder Stream] Request context')?.[1] as Record<string, unknown>
  assert.equal(typeof details.requestId, 'string')
  assert.deepEqual(details, {
    sessionId: 'diagnostic-session', requestId: details.requestId, model: 'tiered', region: 'china',
    purpose: 'session-title', contextTier: 'large', context_length: 1_000_000,
  })
  assert.doesNotMatch(JSON.stringify(details), /Hello|pt-token|jt-token|user-42/)
})
