import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { WebError, type WebSearchProvider, type WebSearchResult } from '@deepseek-ai/dsh-web'
import { getQoderWebSearchUrl, qoderWebSearchPath } from '../src/qoder/transport/endpoints.ts'
import { QoderSearchClient } from '../src/qoder/transport/search.ts'
import { QoderSearchProvider, QODER_SEARCH_PROVIDER_ID } from '../src/dsh/search-provider.ts'
import { QODER_PROVIDER_ID } from '../src/dsh/provider.ts'
import type { QoderTransport } from '../src/qoder/transport/index.ts'
import type { CosyCredentials } from '../src/qoder/transport/wire/cosy.ts'

import { qoderEncodeBody } from '../src/qoder/transport/wire/encoding.ts'

const testCredentials: CosyCredentials = {
  userID: 'user-search-1',
  authToken: 'token-search-1',
  name: 'Search Tester',
  email: 'tester@example.com',
  machineID: 'mach-search-1',
}

test('getQoderWebSearchUrl targets center oneSearch endpoint for global and china', () => {
  assert.equal(getQoderWebSearchUrl('global'), 'https://center.qoder.sh/algo/api/v1/webSearch/oneSearch?Encode=1')
  assert.equal(getQoderWebSearchUrl('china'), 'https://gateway.qoder.com.cn/algo/api/v1/webSearch/oneSearch?Encode=1')
  assert.equal(qoderWebSearchPath, '/api/v1/webSearch/oneSearch')
})

test('QoderSearchClient signs requests and parses search results', async () => {
  let capturedUrl: string | undefined
  let capturedInit: RequestInit | undefined

  const mockResponse = {
    errorCode: 0,
    errorMsg: 'ok',
    requestId: 'req-123',
    pageItems: [
      {
        title: 'DeepSeek Official',
        link: 'https://deepseek.com',
        snippet: 'DeepSeek LLM and research.',
        publishedAt: '2026-01-01',
      },
      {
        title: 'Duplicate URL',
        link: 'https://deepseek.com',
        snippet: 'Duplicate snippet.',
      },
      {
        title: 'Empty Link',
        link: '',
        snippet: 'Ignored item',
      },
    ],
  }

  const client = new QoderSearchClient({
    region: 'global',
    resolveCredentials: async () => testCredentials,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input)
      capturedInit = init
      return new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch,
  })

  const result = await client.search({ query: 'DeepSeek AI' })

  assert.equal(capturedUrl, 'https://center.qoder.sh/algo/api/v1/webSearch/oneSearch?Encode=1')
  assert.equal(capturedInit?.method, 'POST')

  const headers = capturedInit?.headers as Record<string, string>
  assert.ok(headers['Authorization']?.startsWith('Bearer COSY.'))
  assert.equal(headers['Content-Type'], 'application/json')
  assert.equal(headers['Accept-Encoding'], 'identity')
  assert.equal(headers['Cosy-User'], 'user-search-1')

  const expectedOuterBody = JSON.stringify({
    payload: JSON.stringify({
      query: 'DeepSeek AI',
      timeRange: 'NoLimit',
      contents: {
        mainText: false,
        markdownText: false,
        summary: false,
      },
    }),
    encodeVersion: '1',
  })
  assert.equal(capturedInit?.body, qoderEncodeBody(expectedOuterBody))

  // Duplicates and empty links should be handled
  assert.equal(result.sources.length, 1)
  assert.equal(result.sources[0].url, 'https://deepseek.com')
  assert.equal(result.sources[0].title, 'DeepSeek Official')
  assert.equal(result.sources[0].snippet, 'DeepSeek LLM and research.')
  assert.equal(result.sources[0].publishedAt, '2026-01-01')
  assert.equal(result.truncated, false)
})

test('QoderSearchClient refetches credentials and retries once on HTTP 401', async () => {
  let callCount = 0
  let refreshCalled = false

  const client = new QoderSearchClient({
    region: 'china',
    resolveCredentials: async () => testCredentials,
    refreshCredentials: async () => {
      refreshCalled = true
      return { ...testCredentials, authToken: 'new-refreshed-token' }
    },
    fetch: (async () => {
      callCount++
      if (callCount === 1) {
        return new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' })
      }
      return new Response(JSON.stringify({
        errorCode: 0,
        pageItems: [{ title: 'Success', link: 'https://example.com', snippet: 'Success snippet' }],
      }), { status: 200 })
    }) as typeof fetch,
  })

  const result = await client.search({ query: 'test retry' })
  assert.equal(callCount, 2)
  assert.equal(refreshCalled, true)
  assert.equal(result.sources.length, 1)
  assert.equal(result.sources[0].title, 'Success')
})

test('QoderSearchClient throws WebError on backend error code', async () => {
  const client = new QoderSearchClient({
    resolveCredentials: async () => testCredentials,
    fetch: (async () => new Response(JSON.stringify({
      errorCode: 4001,
      errorMsg: 'quota exhausted',
    }), { status: 200 })) as typeof fetch,
  })

  await assert.rejects(
    () => client.search({ query: 'error query' }),
    (err: unknown) => err instanceof WebError && err.code === 'WEB_PROVIDER_ERROR' && err.message.includes('4001'),
  )
})

test('QoderSearchClient honors cancellation signal with WEB_ABORTED', async () => {
  const controller = new AbortController()
  controller.abort()

  const client = new QoderSearchClient({
    resolveCredentials: async () => testCredentials,
    fetch: (async () => new Response('{}')) as typeof fetch,
  })

  await assert.rejects(
    () => client.search({ query: 'aborted query' }, controller.signal),
    (err: unknown) => err instanceof WebError && err.code === 'WEB_ABORTED',
  )
})

test('QoderSearchProvider caps direct results to maxResults', async () => {
  const ctx = new Context()
  const sources = [1, 2, 3].map(index => ({ url: `https://result-${index}.example` }))
  const provider = new QoderSearchProvider({
    ctx,
    resolveTransport: () => ({
      searchWeb: async () => ({ sources, truncated: false }),
    }) as unknown as QoderTransport,
    getWebSearchMode: () => 'always',
  })

  const limited = await provider.search({ query: 'limits', maxResults: 2 })
  assert.deepEqual(limited.sources, sources.slice(0, 2))
  assert.equal(limited.truncated, true)

  const unlimited = await provider.search({ query: 'limits' })
  assert.deepEqual(unlimited.sources, sources)
  assert.equal(unlimited.truncated, false)
})

test('QoderSearchProvider routes Qoder search through transport', async () => {
  const ctx = new Context()
  ctx.provide('agents', {
    currentInitiator: () => ({
      options: {
        provider: QODER_PROVIDER_ID,
      },
    }),
  } as any)

  let transportSearchCalled = false
  const fakeTransport = {
    searchWeb: async () => {
      transportSearchCalled = true
      return { sources: [{ url: 'https://transport.qoder.sh' }], truncated: false }
    },
  } as any

  const provider = new QoderSearchProvider({
    ctx,
    resolveTransport: () => fakeTransport,
    getWebSearchMode: () => 'auto',
  })

  const result = await provider.search({ query: 'test transport' })
  assert.equal(transportSearchCalled, true)
  assert.equal(result.sources[0].url, 'https://transport.qoder.sh')
})

test('QoderSearchProvider falls back to agentDefaultModel when currentInitiator is absent', async () => {
  const ctx = new Context()
  ctx.provide('agents', {
    currentInitiator: () => undefined,
  } as any)
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: QODER_PROVIDER_ID, model: 'gfmodel' }),
  } as any)

  let qoderSearchCalled = false
  const fakeTransport = {
    searchWeb: async () => {
      qoderSearchCalled = true
      return { sources: [{ url: 'https://default-qoder.sh' }], truncated: false }
    },
  } as any

  const provider = new QoderSearchProvider({
    ctx,
    resolveTransport: () => fakeTransport,
    getWebSearchMode: () => 'auto',
  })

  const result = await provider.search({ query: 'test default model' })
  assert.equal(qoderSearchCalled, true)
  assert.equal(result.sources[0].url, 'https://default-qoder.sh')
})
