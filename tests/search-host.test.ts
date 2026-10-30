import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { WebRuntime, WebError, type WebSearchProvider } from '@deepseek-ai/dsh-web'
import { AgentDefaultModelConfig } from '@deepseek-ai/dsh-agent-default-model'
import { bindQoderSearch, QoderSearchProvider } from '../src/dsh/search-provider.ts'
import { QODER_PROVIDER_ID } from '../src/dsh/provider.ts'
import type { QoderWebSearchMode } from '../src/dsh/config.ts'
import type { QoderTransport } from '../src/qoder/transport/index.ts'

const query = { query: 'host selection', maxResults: 1 }
const sources = [{ url: 'https://one.example' }, { url: 'https://two.example' }]
const fails = (code: string) => (error: unknown) => error instanceof WebError && error.code === code

for (const mode of ['auto', 'always', 'disabled'] as const) {
  for (const model of [QODER_PROVIDER_ID, 'other']) {
    for (const count of [0, 1, 2]) {
      test(`host selection: ${mode}, ${model}, ${count} ambient providers`, async () => {
        const ctx = new Context()
        await ctx.plugin(WebRuntime).await()
        ctx.provide('agents', { currentInitiator: () => ({ options: { provider: model } }) } as any)
        let qoderCalls = 0
        let ambientCalls = 0
        const signal = new AbortController().signal
        for (let i = 0; i < count; i++) ctx.web.registerSearchProvider({
          id: `ambient-${i}`, available: () => true,
          search: async (_request, received) => {
            assert.equal(received, signal); ambientCalls++
            return { sources, truncated: false }
          },
        })
        const original = Object.getOwnPropertyDescriptor(ctx.web, 'search')
        const owner = ctx.plugin({ apply: (scope: Context) => bindQoderSearch(scope, {
          getWebSearchMode: () => mode,
          resolveTransport: () => ({ searchWeb: async (_request: unknown, received: AbortSignal) => {
            assert.equal(received, signal); qoderCalls++
            return { sources, truncated: false }
          } }) as unknown as QoderTransport,
        }) })
        await owner.await()
        try {
          const eligible = mode === 'always' || mode === 'auto' && model === QODER_PROVIDER_ID
          if (eligible || count === 1) {
            const result = await ctx.web.search(query, signal)
            assert.deepEqual(result, { sources: sources.slice(0, 1), truncated: true })
            assert.equal(qoderCalls, eligible ? 1 : 0)
            assert.equal(ambientCalls, eligible ? 0 : 1)
          } else {
            await assert.rejects(ctx.web.search(query, signal), fails(count === 0 ? 'WEB_PROVIDER_UNAVAILABLE' : 'WEB_PROVIDER_AMBIGUOUS'))
            assert.equal(qoderCalls, 0)
            assert.equal(ambientCalls, 0)
          }
          await owner.dispose()
          assert.deepEqual(Object.getOwnPropertyDescriptor(ctx.web, 'search'), original)
          if (count === 0) await assert.rejects(ctx.web.search(query), fails('WEB_PROVIDER_UNAVAILABLE'))
        } finally { await ctx.fiber.dispose() }
      })
    }
  }
}

for (const configured of ['qoder', 'ambient', 'unavailable', 'missing']) {
  for (const mode of ['auto', 'always', 'disabled'] as const) {
    test(`configured ${configured} respects host selection in ${mode}`, async () => {
      const ctx = new Context()
      await ctx.plugin(WebRuntime, { searchProvider: configured }).await()
      ctx.provide('agents', { currentInitiator: () => ({ options: { provider: 'other' } }) } as any)
      let qoderCalls = 0
      ctx.web.registerSearchProvider({ id: 'ambient', available: () => true, search: async () => ({ sources, truncated: false }) })
      ctx.web.registerSearchProvider({ id: 'second', available: () => true, search: async () => { throw new Error('Wrong provider') } })
      ctx.web.registerSearchProvider({ id: 'unavailable', available: () => false, search: async () => { throw new Error('Unavailable provider executed') } })
      bindQoderSearch(ctx, {
        getWebSearchMode: () => mode,
        resolveTransport: () => ({ searchWeb: async () => { qoderCalls++; return { sources, truncated: false } } }) as unknown as QoderTransport,
      })
      await ctx.fiber.await()
      try {
        if (mode === 'always' || configured === 'ambient') {
          assert.equal((await ctx.web.search(query)).sources.length, 1)
          assert.equal(qoderCalls, mode === 'always' ? 1 : 0)
        } else {
          await assert.rejects(ctx.web.search(query), fails(configured === 'missing' ? 'WEB_PROVIDER_CONFIGURED_MISSING' : 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE'))
          assert.equal(qoderCalls, 0)
        }
      } finally { await ctx.fiber.dispose() }
    })
  }
}

test('formal default selection is live; initiating selection takes precedence and execution rechecks eligibility', async () => {
  const ctx = new Context()
  let modelProvider = QODER_PROVIDER_ID
  let initiating: string | undefined
  let mode: QoderWebSearchMode = 'auto'
  new AgentDefaultModelConfig(ctx, {
    provider: { get: () => modelProvider }, model: { get: () => 'test-model' }, reasoningEffort: { get: () => undefined },
  } as any)
  ctx.provide('agents', { currentInitiator: () => initiating === undefined ? undefined : { options: { provider: initiating } } } as any)
  let calls = 0
  const provider = new QoderSearchProvider({ ctx, getWebSearchMode: () => mode,
    resolveTransport: () => ({ searchWeb: async () => { calls++; return { sources, truncated: false } } }) as unknown as QoderTransport })
  try {
    assert.equal(provider.available(), true)
    await provider.search(query)
    initiating = 'other'
    assert.equal(provider.available(), false)
    await assert.rejects(provider.search(query), fails('WEB_PROVIDER_UNAVAILABLE'))
    initiating = undefined
    modelProvider = 'other'
    assert.equal(provider.available(), false)
    mode = 'always'
    assert.equal(provider.available(), true)
    mode = 'disabled'
    await assert.rejects(provider.search(query), fails('WEB_PROVIDER_UNAVAILABLE'))
    assert.equal(calls, 1)
  } finally { await ctx.fiber.dispose() }
})

test('disposing Qoder preserves a later owner of the public search method', async () => {
  const ctx = new Context()
  await ctx.plugin(WebRuntime).await()
  const owner = ctx.plugin({ apply: (scope: Context) => bindQoderSearch(scope, {
    getWebSearchMode: () => 'disabled', resolveTransport: () => { throw new Error('Unexpected transport') },
  }) })
  await owner.await()
  const laterSearch = async () => ({ sources, truncated: false })
  ctx.web.search = laterSearch
  try {
    await owner.dispose()
    assert.equal(Object.getOwnPropertyDescriptor(ctx.web, 'search')?.value, laterSearch)
    assert.deepEqual(await ctx.web.search(query), { sources, truncated: false })
  } finally { await ctx.fiber.dispose() }
})

test('missing required WebRuntime search API fails explicitly', () => {
  const ctx = { inject: (_names: string[], callback: (scope: unknown) => void) => callback({ web: {} }) } as unknown as Context
  assert.throws(() => bindQoderSearch(ctx, {
    getWebSearchMode: () => 'auto', resolveTransport: () => { throw new Error('Unexpected transport') },
  }), /requires the DSH WebRuntime.search API/)
})
