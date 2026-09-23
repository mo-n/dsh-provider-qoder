import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type {
  CredentialInfo,
  CredentialKey,
  CredentialRecord,
  CredentialRecordEntry,
  CredentialRecordInfo,
  CredentialRef,
  ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { SettingsProvider } from '@deepseek-ai/dsh-settings-legacy'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import * as plugin from '../src/index.ts'
import { Config } from '../src/dsh/config.ts'
import { QODER_PROVIDER_ID } from '../src/dsh/provider.ts'
import type { QoderCatalogModel } from '../src/qoder/catalog.ts'
import { DefaultQoderTransport } from '../src/qoder/transport/default-transport.ts'

class MemorySettings extends SettingsProvider {
  readonly writable = true

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve({})
  }

  protected persist(_ns: SettingsNamespace, _section: Record<string, unknown>): Promise<void> {
    return Promise.resolve()
  }
}

function memorySettings(ctx: Context): MemorySettings {
  return ctx.settings as unknown as MemorySettings
}

class RecordingSettings extends MemorySettings {
  readonly writes: Record<string, unknown>[] = []
  onPersist?: () => Promise<void>

  protected override async persist(_ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.writes.push(section)
    await this.onPersist?.()
  }
}

class TestCredentials extends CredentialProvider {
  constructor(ctx: Context) {
    super(ctx)
  }

  override resolve(_ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    return Promise.resolve(undefined)
  }

  override describe(_ref: CredentialRef): Promise<CredentialInfo> {
    return Promise.resolve({ configured: false, writable: true })
  }

  override set(): Promise<void> {
    return Promise.resolve()
  }

  override unset(): Promise<void> {
    return Promise.resolve()
  }

  override readRecord(_key: CredentialKey): Promise<CredentialRecord | undefined> {
    return Promise.resolve(undefined)
  }

  override describeRecord(_key: CredentialKey): Promise<CredentialRecordInfo> {
    return Promise.resolve({ configured: false, writable: true })
  }

  override listRecords(): Promise<readonly CredentialRecordEntry[]> {
    return Promise.resolve([])
  }

  override modifyRecord(
    _key: CredentialKey,
    _mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    return Promise.resolve(undefined)
  }

  override deleteRecord(): Promise<void> {
    return Promise.resolve()
  }
}

test('package exports the expected plugin surface', () => {
  assert.equal(plugin.name, 'provider-qoder')
  assert.deepEqual(plugin.inject, ['llm', 'credentials', 'connection', 'attachments'])
  assert.equal(typeof plugin.apply, 'function')
  assert.equal(typeof plugin.Config, 'function')
  assert.equal('QoderAdapter' in plugin, false)
  assert.equal('fetchQoderModels' in plugin, false)
  assert.equal('apiKeyEnv' in Config({}), false)
})

test('apply registers a valid adapter with the real DSH runtime', async () => {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(TestCredentials)
  await ctx.plugin(MemorySettings).await()
  plugin.apply(ctx, {})
  assert.equal(
    ctx.llm.listConfigurableProviders().some(provider => provider.provider === QODER_PROVIDER_ID),
    false,
  )
  const models = await ctx.llm.listModels(QODER_PROVIDER_ID)
  assert.ok(models.length > 1)
  assert.ok(models.some(model => model.id === 'cmodel'))
  assert.ok(models.some(model => model.id === 'auto'))
  assert.deepEqual(ctx.llm.providerRetryPolicy(QODER_PROVIDER_ID), {
    mode: 'normal',
    maxRetries: 5,
    retryableCodes: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
    initialDelayMs: 500,
    maxDelayMs: 10_000,
    jitterRatio: 0.1,
  })
  await ctx.settings.update('provider-qoder' as SettingsNamespace, {
    modelsByRegion: { global: [{ id: 'custom-qoder', name: 'Custom Qoder' }] },
  })
  assert.deepEqual(
    (await ctx.llm.listModels(QODER_PROVIDER_ID)).map(model => model.id),
    ['custom-qoder'],
  )
  await ctx.settings.update('provider-qoder' as SettingsNamespace, { region: 'china' })
  assert.ok((await ctx.llm.listModels(QODER_PROVIDER_ID)).some(model => model.id === 'cmodel'))
  assert.equal((await ctx.llm.listModels(QODER_PROVIDER_ID)).some(model => model.id === 'custom-qoder'), false)
  await ctx.settings.update('provider-qoder' as SettingsNamespace, {
    modelsByRegion: {
      global: [{ id: 'custom-qoder', name: 'Custom Qoder' }],
      china: [{ id: 'china-qoder', name: 'China Qoder' }],
    },
  })
  assert.deepEqual((await ctx.llm.listModels(QODER_PROVIDER_ID)).map(model => model.id), ['china-qoder'])
  await ctx.settings.update('provider-qoder' as SettingsNamespace, { region: 'global' })
  assert.deepEqual((await ctx.llm.listModels(QODER_PROVIDER_ID)).map(model => model.id), ['custom-qoder'])
  const prepared = await ctx.llm.prepareCall({ provider: QODER_PROVIDER_ID, model: 'cmodel' })
  assert.equal(prepared.config.provider, QODER_PROVIDER_ID)
  assert.equal(prepared.config.model, 'cmodel')
  assert.deepEqual(ctx.llm.listProviders().map(provider => provider.id), [QODER_PROVIDER_ID])

})

test('legacy model configuration is scoped to its selected region', async () => {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(TestCredentials)
  await ctx.plugin(MemorySettings).await()
  plugin.apply(ctx, {
    region: 'china',
    models: [{ id: 'legacy-china', name: 'Legacy China' }],
  })

  assert.deepEqual((await ctx.llm.listModels(QODER_PROVIDER_ID)).map(model => model.id), ['legacy-china'])
  await ctx.settings.update('provider-qoder' as SettingsNamespace, { region: 'global' })
  assert.ok((await ctx.llm.listModels(QODER_PROVIDER_ID)).some(model => model.id === 'cmodel'))
  assert.equal((await ctx.llm.listModels(QODER_PROVIDER_ID)).some(model => model.id === 'legacy-china'), false)
})

test('discovery reconciles runtime and stored budgets and a failed discovery preserves them', async (t) => {
  let empty = false
  let supportsImages = false
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/jobToken/exchange')) return new Response(JSON.stringify({ token: 'jt-test', expires_in: 3_600_000 }))
    if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'user-test' }))
    assert.ok(url.includes('/model/list'))
    return new Response(JSON.stringify({ assistant: empty ? [] : ['large', 'small'].map(key => ({
      key, enable: true, is_reasoning: true, is_vl: supportsImages,
      context_config: { small: { token_count: 200_000, is_default: true }, large: { token_count: 1_000_000 } },
      thinking_config: {
        disabled: { is_default: true },
        enabled: { efforts: { high: { is_default: true } } },
      },
    })) }))
  })
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(TestCredentials)
  await ctx.plugin(MemorySettings).await()
  plugin.apply(ctx, { modelsByRegion: { global: [
    { id: 'large', name: 'Large', contextWindow: 1_000_000 },
    { id: 'small', name: 'Small', contextWindow: 100_000 },
  ] } })
  const ns = 'provider-qoder' as SettingsNamespace
  const discover = () => ctx.llm.discoverModels(ns, { provider: QODER_PROVIDER_ID, apiKey: 'pt-test' })
  assert.deepEqual((await ctx.llm.listModels(QODER_PROVIDER_ID))[0].inputModalities, ['text'])
  supportsImages = true
  await discover()
  assert.deepEqual((await ctx.llm.listModels(QODER_PROVIDER_ID))[0].inputModalities, ['text', 'image'])
  for (const [id, expected] of [['large', 200_000], ['small', 100_000]] as const) {
    const prepared = await ctx.llm.prepareCall({ provider: QODER_PROVIDER_ID, model: id })
    assert.equal(prepared.context?.contextWindow, expected)
    assert.equal(prepared.config.reasoningEffort, undefined)
  }
  const stored = memorySettings(ctx).get(ns)
  assert.deepEqual((stored as plugin.Config).modelsByRegion?.global?.map(model => model.contextWindow), [200_000, 100_000])
  empty = true
  await assert.rejects(discover, /no enabled models/u)
  assert.deepEqual(memorySettings(ctx).get(ns), stored)
  assert.equal((await ctx.llm.prepareCall({ provider: QODER_PROVIDER_ID, model: 'large' })).context?.contextWindow, 200_000)
})

function normalizedCatalog(models: QoderCatalogModel[]) {
  return Config({ modelsByRegion: { global: models } }).modelsByRegion?.global
}

async function modelRuntime(config: plugin.Config) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(TestCredentials)
  await ctx.plugin(RecordingSettings).await()
  plugin.apply(ctx, config)
  return { ctx, settings: ctx.settings as unknown as RecordingSettings, ns: 'provider-qoder' as SettingsNamespace }
}

/** Let background settings writes and their revision retries settle. */
async function drain(): Promise<void> {
  for (let turn = 0; turn < 20; turn++) await new Promise<void>(resolve => setImmediate(resolve))
}

test('automatic discovery persists rates without changing selection and refreshes after five minutes', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 })
  let advertised: QoderCatalogModel[] = [
    { id: 'chosen', name: 'Remote name', priceFactor: 2, contextWindow: 200_000, maxTokens: 32_768 },
    { id: 'disabled', name: 'Disabled', priceFactor: 8 },
  ]
  const discovery = t.mock.method(DefaultQoderTransport.prototype, 'discoverModels', async () => advertised)
  const chosen = { id: 'chosen', name: 'Chosen name', contextWindow: 100_000, maxTokens: 4_096, priceFactor: 1 }
  const china = [{ id: 'china-model', name: 'China model', priceFactor: 7 }]
  const { ctx, settings, ns } = await modelRuntime({ modelsByRegion: { global: [chosen], china } })
  const stored = () => (memorySettings(ctx).get(ns) as plugin.Config).modelsByRegion!

  assert.deepEqual((await ctx.llm.listModels(QODER_PROVIDER_ID)).map(model => [model.id, model.name]), [
    ['chosen', 'Chosen name （2x）'],
  ])
  await drain()
  assert.deepEqual(stored().global, normalizedCatalog([{ ...chosen, priceFactor: 2 }]))
  assert.deepEqual(stored().china, normalizedCatalog(china))
  assert.equal((settings.writes[0] as plugin.Config).modelsByRegion?.global?.[0].priceFactor, 2)
  assert.equal(settings.writes.length, 1)

  t.mock.timers.tick(299_999)
  await ctx.llm.listModels(QODER_PROVIDER_ID)
  await drain()
  assert.equal(discovery.mock.callCount(), 1)
  assert.equal(settings.writes.length, 1)
  t.mock.timers.tick(1)
  advertised = [{ ...advertised[0], priceFactor: 0 }]
  assert.match((await ctx.llm.listModels(QODER_PROVIDER_ID))[0].name, /0x/u)
  await drain()
  assert.equal(stored().global?.[0].priceFactor, 0)

  t.mock.timers.tick(300_000)
  advertised = [{ id: 'chosen', name: 'Remote name', contextWindow: 200_000 }]
  assert.equal((await ctx.llm.listModels(QODER_PROVIDER_ID))[0].name, chosen.name)
  await drain()
  assert.equal(Object.hasOwn(stored().global![0], 'priceFactor'), false)
  assert.equal(settings.writes.length, 3)
  t.mock.timers.tick(300_000)
  await ctx.llm.listModels(QODER_PROVIDER_ID)
  await drain()
  assert.equal(discovery.mock.callCount(), 4)
  assert.equal(settings.writes.length, 3)
  assert.deepEqual(stored().china, normalizedCatalog(china))
})

test('automatic discovery returns the catalog before settings persistence finishes', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 })
  t.mock.method(DefaultQoderTransport.prototype, 'discoverModels', async () => [
    { id: 'chosen', name: 'Remote name', priceFactor: 3 },
  ])
  const { ctx, settings } = await modelRuntime({ modelsByRegion: {
    global: [{ id: 'chosen', name: 'Chosen name', priceFactor: 1 }],
  } })
  let release!: () => void
  let persistStarted!: () => void
  const started = new Promise<void>(resolve => { persistStarted = resolve })
  settings.onPersist = async () => {
    settings.onPersist = undefined
    persistStarted()
    await new Promise<void>(resolve => { release = resolve })
  }

  let listed = false
  const reading = ctx.llm.listModels(QODER_PROVIDER_ID).then((models) => {
    listed = true
    return models
  })
  await started
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(listed, true)
  assert.match((await reading)[0].name, /3x/u)
  release()
  await drain()
})

test('settings edits do not persist fallback models before a successful discovery', async () => {
  const { ctx, settings, ns } = await modelRuntime({})
  await ctx.llm.listModels(QODER_PROVIDER_ID)
  await ctx.settings.update(ns, { webSearchMode: 'disabled' })
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(settings.writes.length, 1)
  assert.deepEqual((memorySettings(ctx).get(ns) as plugin.Config).modelsByRegion, {})
})

test('automatic discovery and settings persistence failures remain advisory', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 })
  let offline = false
  const discovery = t.mock.method(DefaultQoderTransport.prototype, 'discoverModels', async () => {
    if (offline) throw new Error('offline')
    return [{ id: 'chosen', name: 'Chosen', priceFactor: 3 }]
  })
  const chosen = { id: 'chosen', name: 'Chosen', priceFactor: 1 }
  const { ctx, settings, ns } = await modelRuntime({ modelsByRegion: { global: [chosen] } })
  settings.onPersist = async () => { throw new Error('storage unavailable') }

  assert.match((await ctx.llm.listModels(QODER_PROVIDER_ID))[0].name, /3x/u)
  await drain()
  assert.equal(settings.writes.length, 1)
  assert.deepEqual((memorySettings(ctx).get(ns) as plugin.Config).modelsByRegion?.global, normalizedCatalog([chosen]))
  await ctx.llm.listModels(QODER_PROVIDER_ID)
  await drain()
  assert.equal(discovery.mock.callCount(), 1)
  assert.equal(settings.writes.length, 1)
  offline = true
  t.mock.timers.tick(300_000)
  assert.match((await ctx.llm.listModels(QODER_PROVIDER_ID))[0].name, /3x/u)
  await drain()
  assert.deepEqual((memorySettings(ctx).get(ns) as plugin.Config).modelsByRegion?.global, normalizedCatalog([chosen]))
  assert.equal(settings.writes.length, 1)
})

test('automatic discovery cannot overwrite a settings save already awaiting persistence', async (t) => {
  let completeDiscovery!: (models: QoderCatalogModel[]) => void
  let discoveryStarted!: () => void
  const started = new Promise<void>(resolve => { discoveryStarted = resolve })
  t.mock.method(DefaultQoderTransport.prototype, 'discoverModels', () => {
    discoveryStarted()
    return new Promise<QoderCatalogModel[]>(resolve => { completeDiscovery = resolve })
  })
  const { ctx, settings, ns } = await modelRuntime({ modelsByRegion: {
    global: [{ id: 'chosen', name: 'Original', priceFactor: 1 }, { id: 'removed', name: 'Removed' }],
    china: [{ id: 'old-china', name: 'Old China' }],
  } })
  const reading = ctx.llm.listModels(QODER_PROVIDER_ID)
  await started

  let releaseSave!: () => void
  let saveStarted!: () => void
  const saving = new Promise<void>(resolve => { saveStarted = resolve })
  const gate = new Promise<void>(resolve => { releaseSave = resolve })
  settings.onPersist = async () => {
    settings.onPersist = undefined
    saveStarted()
    await gate
  }
  const chosen = { id: 'chosen', name: 'User renamed', contextWindow: 50_000, maxTokens: 2_048 }
  const china = [{ id: 'new-china', name: 'New China', priceFactor: 9 }]
  const save = ctx.settings.update(ns, { modelsByRegion: { global: [chosen], china }, webSearchMode: 'disabled' })
  await saving
  completeDiscovery([
    { id: 'chosen', name: 'Remote name', priceFactor: 4, contextWindow: 200_000 },
    { id: 'removed', name: 'Removed', priceFactor: 2 },
    { id: 'disabled', name: 'Disabled', priceFactor: 8 },
  ])
  // Drain the discovery continuation while the earlier user write is still blocked.
  await new Promise<void>(resolve => setImmediate(resolve))
  releaseSave()
  await Promise.all([save, reading])
  // The queued metadata write reconciles under a stale revision, so let its
  // conflict retry settle before reading the committed catalog.
  await drain()

  const stored = memorySettings(ctx).get(ns) as plugin.Config
  assert.deepEqual(stored.modelsByRegion?.global, normalizedCatalog([{ ...chosen, priceFactor: 4 }]))
  assert.deepEqual(stored.modelsByRegion?.china, normalizedCatalog(china))
  assert.equal(stored.webSearchMode, 'disabled')
  assert.deepEqual((await ctx.llm.listModels(QODER_PROVIDER_ID)).map(model => [model.id, model.name]), [
    ['chosen', 'User renamed （4x）'],
  ])
})

test('apply succeeds with default Config schema and empty models array', async () => {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(TestCredentials)
  await ctx.plugin(MemorySettings).await()
  const normalizedConfig = Config({})
  assert.deepEqual(normalizedConfig.models, [])
  plugin.apply(ctx, normalizedConfig)
  const models = await ctx.llm.listModels(QODER_PROVIDER_ID)
  assert.ok(models.length > 0)
  assert.ok(models.some(model => model.id === 'cmodel'))

  const ctxEmptyModels = new Context()
  await ctxEmptyModels.plugin(LlmRuntime)
  await ctxEmptyModels.plugin(TestCredentials)
  await ctxEmptyModels.plugin(MemorySettings).await()
  plugin.apply(ctxEmptyModels, { models: [] })
  const fallbackModels = await ctxEmptyModels.llm.listModels(QODER_PROVIDER_ID)
  assert.ok(fallbackModels.length > 0)
  assert.ok(fallbackModels.some(model => model.id === 'cmodel'))
})

test('apply mounts the settings RPC on the connection Fetch registry', async () => {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(TestCredentials)
  await ctx.plugin(MemorySettings).await()

  const registeredPaths: string[] = []
  const fakeConnection = {
    fetch: {
      register: (route: { path: string }) => {
        registeredPaths.push(route.path)
        return () => {}
      },
    },
  }
  ctx.provide('connection', fakeConnection as any)
  ctx.provide('attachments', {} as any)

  const fiber = ctx.plugin({
    name: plugin.name,
    inject: plugin.inject,
    apply: plugin.apply,
  }, {})
  await fiber.await()

  // Exact Fetch routes ride on the Connection plugin's own /api route, so the
  // host half needs no webServer injection of its own.
  assert.deepEqual(registeredPaths, [
    '/api/qoder-subscription/account',
    '/api/qoder-subscription/models',
  ])
})

test('apply survives a connection service without a Fetch registry', async () => {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(TestCredentials)
  await ctx.plugin(MemorySettings).await()
  ctx.provide('connection', { rpc: { handle: () => () => {} } } as any)
  ctx.provide('attachments', {} as any)

  const fiber = ctx.plugin({
    name: plugin.name,
    inject: plugin.inject,
    apply: plugin.apply,
  }, {})
  await fiber.await()

  // The model catalog stays registered even though the settings RPC is gone.
  const models = await ctx.llm.listModels(QODER_PROVIDER_ID)
  assert.ok(models.some(model => model.id === 'cmodel'))
})

test('apply registers QoderSearchProvider with ctx.web when web service is provided', async () => {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(TestCredentials)
  await ctx.plugin(MemorySettings).await()
  ctx.provide('connection', { fetch: { register: () => () => {} } } as any)
  ctx.provide('attachments', {} as any)

  let registeredSearchProvider: { id: string } | undefined
  const fakeWeb = {
    registerSearchProvider: (provider: { id: string }) => {
      registeredSearchProvider = provider
      return () => {}
    },
  }
  ctx.provide('web', fakeWeb as any)

  plugin.apply(ctx, { webSearchMode: 'auto' })
  await ctx.fiber.await()

  assert.ok(registeredSearchProvider)
  assert.equal(registeredSearchProvider.id, 'qoder')
})

test('apply transparently routes web.search to Qoder when Qoder model is active', async () => {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(TestCredentials)
  await ctx.plugin(MemorySettings).await()
  ctx.provide('connection', { fetch: { register: () => () => {} } } as any)
  ctx.provide('attachments', {} as any)

  let originalSearchCalled = false
  const fakeWeb = {
    searchProviders: new Map(),
    registerSearchProvider: () => () => {},
    search: async () => {
      originalSearchCalled = true
      return { sources: [{ url: 'https://fallback.com' }], truncated: false }
    },
  }
  ctx.provide('web', fakeWeb as any)

  ;(ctx as unknown as Record<string, unknown>).agents = {
    currentInitiator: () => ({
      options: { provider: QODER_PROVIDER_ID },
    }),
  }

  plugin.apply(ctx, { webSearchMode: 'auto' })
  await ctx.fiber.await()

  await assert.rejects(
    () => ctx.web.search({ query: 'hello' }),
    (err: unknown) => {
      assert.equal(originalSearchCalled, false)
      return true
    },
  )

})
