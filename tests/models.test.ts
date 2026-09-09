import test from 'node:test'
import assert from 'node:assert/strict'
import { QoderLlmError } from '../src/errors.ts'
import {
  fetchQoderModels,
  hasSameQoderDiscoveryMetadata,
  mergeQoderDiscoveryMetadata,
  normalizeQoderModels,
} from '../src/models.ts'

const payload = {
  chat: [
    { key: 'disabled', enable: false, display_name: 'Disabled' },
    {
      key: 'reasoner',
      enable: true,
      display_name: 'Reasoner',
      max_input_tokens: 100_000,
      max_output_tokens: 16_384,
      source: 'premium',
      price_factor: 0.5,
      is_reasoning: true,
      thinking_config: {
        enabled: {
          efforts: {
            high: { description: 'Deep reasoning', is_default: true },
            custom: { description: 'Provider-specific reasoning' },
            low: { description: 'Fast reasoning' },
          },
        },
      },
      context_config: {
        small: { token_count: 100_000, is_default: true },
        large: { token_count: 400_000 },
      },
    },
    { key: 'reasoner', enable: true, display_name: 'Duplicate' },
  ],
}

test('normalizeQoderModels keeps enabled unique models and their transport metadata', () => {
  assert.deepEqual(normalizeQoderModels(payload), [{
    id: 'reasoner',
    name: 'Reasoner',
    contextWindow: 400_000,
    maxTokens: 16_384,
    source: 'premium',
    isReasoning: true,
    supportsEffort: true,
    reasoningEfforts: [
      { id: 'low', name: 'low', description: 'Fast reasoning' },
      { id: 'high', name: 'high', description: 'Deep reasoning' },
      { id: 'custom', name: 'custom', description: 'Provider-specific reasoning' },
    ],
    defaultReasoningEffort: 'high',
    priceFactor: 0.5,
    contextOptions: {
      small: { tokenCount: 100_000, isDefault: false },
      large: { tokenCount: 400_000, isDefault: true },
    },
  }])
})

test('mergeQoderDiscoveryMetadata restores effort and rate data stripped by generic discovery', () => {
  const configured = [{
    id: 'reasoner',
    name: 'Chosen name',
    contextWindow: 200_000,
    maxTokens: 8_192,
  }, {
    id: 'manual',
    name: 'Manual model',
    reasoningEfforts: [{ id: 'legacy', name: 'legacy' }],
  }]
  const discovered = normalizeQoderModels(payload)

  const enriched = mergeQoderDiscoveryMetadata(configured, discovered)
  assert.deepEqual(enriched, [{
    id: 'reasoner',
    name: 'Chosen name',
    contextWindow: 200_000,
    maxTokens: 8_192,
    source: 'premium',
    isReasoning: true,
    supportsEffort: true,
    reasoningEfforts: [
      { id: 'low', name: 'low', description: 'Fast reasoning' },
      { id: 'high', name: 'high', description: 'Deep reasoning' },
      { id: 'custom', name: 'custom', description: 'Provider-specific reasoning' },
    ],
    defaultReasoningEffort: 'high',
    priceFactor: 0.5,
    contextOptions: {
      small: { tokenCount: 100_000, isDefault: false },
      large: { tokenCount: 400_000, isDefault: true },
    },
  }, {
    id: 'manual',
    name: 'Manual model',
    reasoningEfforts: [{ id: 'legacy', name: 'legacy' }],
  }])
  assert.equal(hasSameQoderDiscoveryMetadata(configured, enriched), false)
  assert.equal(hasSameQoderDiscoveryMetadata(enriched, enriched), true)
})

test('fetchQoderModels calls the encoded Global catalog with COSY authentication', async () => {
  let request: { url: string; init?: RequestInit } | undefined
  const logs: Array<{ message: string; details: unknown }> = []
  const models = await fetchQoderModels({
    userID: 'user-1',
    authToken: 'job-token',
    name: 'Subscriber',
    email: 'subscriber@example.com',
    machineID: 'machine-1',
  }, {
    logger: {
      debug: (message, details) => { logs.push({ message, details }) },
    },
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      request = { url: String(input), init }
      return new Response(JSON.stringify(payload))
    }) as typeof fetch,
  })

  assert.equal(models[0]?.id, 'reasoner')
  assert.equal(request?.url, 'https://api3.qoder.sh/algo/api/v2/model/list?Encode=1')
  assert.equal(request?.init?.method, 'GET')
  const headers = request?.init?.headers as Record<string, string>
  assert.match(headers.Authorization, /^Bearer COSY\./u)
  assert.equal(headers['Cosy-Sigpath'], '/api/v2/model/list')
  assert.equal(typeof (logs[1]?.details as { durationMs?: unknown }).durationMs, 'number')
  assert.deepEqual(logs.map((entry) => {
    if (entry.message !== '[Qoder Models] Catalog request completed') return entry
    const { durationMs: _, ...details } = entry.details as Record<string, unknown>
    return { ...entry, details }
  }), [
    {
      message: '[Qoder Models] Requesting model catalog',
      details: { url: 'https://api3.qoder.sh/algo/api/v2/model/list?Encode=1' },
    },
    {
      message: '[Qoder Models] Catalog request completed',
      details: { url: 'https://api3.qoder.sh/algo/api/v2/model/list?Encode=1', status: 200 },
    },
    { message: '[Qoder Models] Model catalog resolved', details: { models } },
  ])
})

test('fetchQoderModels rejects malformed and empty catalogs', async () => {
  await assert.rejects(() => fetchQoderModels({
    userID: 'user-1', authToken: 'job-token', name: '', email: '', machineID: 'machine-1',
  }, { fetch: (async () => new Response('{')) as typeof fetch }), /invalid JSON/u)
  await assert.rejects(() => fetchQoderModels({
    userID: 'user-1', authToken: 'job-token', name: '', email: '', machineID: 'machine-1',
  }, { fetch: (async () => new Response(JSON.stringify({ chat: [] }))) as typeof fetch }), /no enabled models/u)
})

test('fetchQoderModels classifies HTTP and network failures', async () => {
  const credentials = {
    userID: 'user-1', authToken: 'job-token', name: '', email: '', machineID: 'machine-1',
  }
  await assert.rejects(() => fetchQoderModels(credentials, {
    fetch: (async () => new Response('', { status: 503 })) as typeof fetch,
  }), (error: Error) => (
    error instanceof QoderLlmError
    && error.code === 'SERVER'
    && error.failure.status === 503
  ))
  await assert.rejects(() => fetchQoderModels(credentials, {
    fetch: (async () => { throw new TypeError('fetch failed') }) as typeof fetch,
  }), (error: Error) => error instanceof QoderLlmError && error.code === 'TRANSPORT')
})

test('fetchQoderModels applies its own deadline and normalizes body-read cancellation', async () => {
  const credentials = {
    userID: 'user-1', authToken: 'job-token', name: '', email: '', machineID: 'machine-1',
  }
  await assert.rejects(() => fetchQoderModels(credentials, {
    timeoutMs: 5,
    fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('timeout', 'AbortError')), { once: true })
    })) as typeof fetch,
  }), (error: Error) => error instanceof QoderLlmError && error.code === 'TIMEOUT')

  const caller = new AbortController()
  await assert.rejects(() => fetchQoderModels(credentials, {
    signal: caller.signal,
    fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        init?.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')))
        queueMicrotask(() => caller.abort())
      },
    }))) as typeof fetch,
  }), (error: Error) => error instanceof QoderLlmError && error.code === 'ABORTED')
})

test('fetchQoderModels rejects oversized catalog responses', async () => {
  await assert.rejects(() => fetchQoderModels({
    userID: 'user-1', authToken: 'job-token', name: '', email: '', machineID: 'machine-1',
  }, {
    fetch: (async () => new Response('', {
      headers: { 'content-length': String(3 * 1024 * 1024) },
    })) as typeof fetch,
  }), (error: Error) => error instanceof QoderLlmError && error.code === 'MALFORMED_RESPONSE')
})
