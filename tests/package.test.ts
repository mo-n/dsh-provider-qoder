import test from 'node:test'
import assert from 'node:assert/strict'
import { Context, Service } from '@deepseek-ai/cordis'
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
import type { WebSearchProvider, WebSearchRequest } from '@deepseek-ai/dsh-web'
import { SettingsConflictError, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import * as plugin from '../src/index.ts'
import { Config, type LiveConfig } from '../src/dsh/config.ts'
import { QODER_PROVIDER_ID } from '../src/dsh/provider.ts'
import type { QoderCatalogModel } from '../src/qoder/catalog.ts'
import { DefaultQoderTransport } from '../src/qoder/transport/default-transport.ts'

interface MemorySection {
  value: plugin.Config
  revision: number
}

function mergeSettings(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    const previous = merged[key]
    merged[key] = value !== null && typeof value === 'object' && !Array.isArray(value)
      && previous !== null && typeof previous === 'object' && !Array.isArray(previous)
      ? mergeSettings(previous as Record<string, unknown>, value as Record<string, unknown>)
      : structuredClone(value)
  }
  return merged
}

/** In-memory settings seam for package integration tests. */
class MemorySettings extends Service {
  readonly writable = true
  private readonly sections = new Map<SettingsNamespace, MemorySection>()
  private readonly queues = new Map<SettingsNamespace, Promise<void>>()
  private readonly hostContext: Context
  private ownerContext: Context | undefined

  constructor(ctx: Context) {
    super(ctx, 'settings')
    this.hostContext = ctx
    this.setConfig({})
  }

  setConfig(config: plugin.Config, owner?: Context): void {
    this.ownerContext = owner
    this.sections.set('provider-qoder' as SettingsNamespace, { value: Config(config), revision: 0 })
  }

  get(ns: SettingsNamespace): plugin.Config | undefined {
    return this.sections.get(ns)?.value
  }

  describe() {
    return [...this.sections].map(([ns, section]) => ({ ns, value: section.value, revision: section.revision }))
  }

  update(ns: SettingsNamespace, patch: object, expectedRevision?: number): Promise<void> {
    const section = this.sections.get(ns)
    if (section === undefined) return Promise.reject(new Error(`Unknown settings namespace: ${ns}`))
    const pending = (this.queues.get(ns) ?? Promise.resolve()).then(async () => {
      if (expectedRevision !== undefined && expectedRevision !== section.revision) {
        throw new SettingsConflictError(ns, expectedRevision, section.revision)
      }
      const next = Config(mergeSettings(section.value as Record<string, unknown>, patch as Record<string, unknown>))
      const owner = this.ownerContext ?? this.hostContext
      owner.waterfall(owner.fiber, 'internal/config', next, () => next)
      await this.persist(ns, next)
      section.value = next
      section.revision += 1
      const emit = this.hostContext.emit.bind(this.hostContext) as (event: string) => void
      emit('loader/volatile-update')
    })
    this.queues.set(ns, pending.catch(() => {}))
    return pending
  }

  protected persist(_ns: SettingsNamespace, _section: plugin.Config): Promise<void> {
    return Promise.resolve()
  }
}

function memorySettings(ctx: Context): MemorySettings {
  return ctx.settings as unknown as MemorySettings
}

function applyWithSettings(ctx: Context, config: plugin.Config = {}): void {
  const settings = memorySettings(ctx)
  settings.setConfig(config, ctx)
  plugin.apply(ctx, { get: () => settings.get('provider-qoder' as SettingsNamespace) } as LiveConfig)
}

class RecordingSettings extends MemorySettings {
  readonly writes: Record<string, unknown>[] = []
  onPersist?: () => Promise<void>

  protected override async persist(_ns: SettingsNamespace, section: plugin.Config): Promise<void> {
    this.writes.push(section as Record<string, unknown>)
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
  applyWithSettings(ctx, {})
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

test('settings reject an invalid live catalog before committing it', async () => {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(TestCredentials)
  await ctx.plugin(MemorySettings).await()
  applyWithSettings(ctx)
  await ctx.fiber.await()
  const ns = 'provider-qoder' as SettingsNamespace
  const previous = memorySettings(ctx).get(ns)

  await assert.rejects(
    ctx.settings.update(ns, { modelsByRegion: { unsupported: [{ id: 'invalid', name: 'Invalid' }] } }),
    /unsupported model catalog region/u,
  )
  assert.deepEqual(memorySettings(ctx).get(ns), previous)
})

test('model configuration is scoped to its selected region', async () => {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(TestCredentials)
  await ctx.plugin(MemorySettings).await()
  applyWithSettings(ctx, {
    region: 'china',
    modelsByRegion: { china: [{ id: 'china-only', name: 'China Only' }] },
  })

  assert.deepEqual((await ctx.llm.listModels(QODER_PROVIDER_ID)).map(model => model.id), ['china-only'])
  await ctx.settings.update('provider-qoder' as SettingsNamespace, { region: 'global' })
  assert.ok((await ctx.llm.listModels(QODER_PROVIDER_ID)).some(model => model.id === 'cmodel'))
  assert.equal((await ctx.llm.listModels(QODER_PROVIDER_ID)).some(model => model.id === 'china-only'), false)
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
  applyWithSettings(ctx, { modelsByRegion: { global: [
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
  applyWithSettings(ctx, config)
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
  assert.match((await ctx.llm.listModels(QODER_PROVIDER_ID))[0].name, /免费/u)
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
    '/api/qoder-subscription/sessionTier',
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

  applyWithSettings(ctx, { webSearchMode: 'auto' })
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

  let ambientCalls = 0
  let registeredProvider: WebSearchProvider | undefined
  const fakeWeb = {
    searchProviders: new Map(),
    registerSearchProvider: (provider: WebSearchProvider) => {
      registeredProvider = provider
      return () => {}
    },
    search: async (_request: WebSearchRequest, _signal?: AbortSignal) => {
      ambientCalls++
      return { sources: [{ url: 'https://fallback.com' }], truncated: false }
    },
  }
  const originalSearch = fakeWeb.search
  ctx.provide('web', fakeWeb as any)

  let currentProvider = QODER_PROVIDER_ID
  let mode: 'auto' | 'always' | 'disabled' = 'auto'
  ;(ctx as unknown as Record<string, unknown>).agents = {
    currentInitiator: () => ({
      options: { provider: currentProvider },
    }),
  }

  const fiber = ctx.plugin({ name: plugin.name, inject: plugin.inject, apply: plugin.apply }, {
    get: () => ({ webSearchMode: mode }),
  } as LiveConfig)
  await fiber.await()
  assert.ok(registeredProvider)
  assert.notEqual(fakeWeb.search, originalSearch)

  let qoderCalls = 0
  const controller = new AbortController()
  registeredProvider.search = async (request, signal) => {
    assert.equal(request.query, 'hello')
    assert.equal(signal, controller.signal)
    qoderCalls++
    return { sources: [{ url: 'https://qoder.sh' }], truncated: false }
  }
  const qoderResult = await ctx.web.search({ query: 'hello' }, controller.signal)
  assert.equal(qoderResult.sources[0].url, 'https://qoder.sh')
  assert.equal(qoderCalls, 1)
  assert.equal(ambientCalls, 0)

  currentProvider = 'deepseek-official'
  const ambientResult = await ctx.web.search({ query: 'hello' })
  assert.equal(ambientResult.sources[0].url, 'https://fallback.com')
  assert.equal(qoderCalls, 1)
  assert.equal(ambientCalls, 1)

  mode = 'always'
  const forcedResult = await ctx.web.search({ query: 'hello' }, controller.signal)
  assert.equal(forcedResult.sources[0].url, 'https://qoder.sh')
  assert.equal(qoderCalls, 2)

  mode = 'disabled'
  const disabledResult = await ctx.web.search({ query: 'hello' })
  assert.equal(disabledResult.sources[0].url, 'https://fallback.com')
  assert.equal(ambientCalls, 2)

  await fiber.dispose()
  assert.equal(fakeWeb.search, originalSearch)
})

test('a stored context tier widens the context window reported to DSH', async () => {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(TestCredentials)
  await ctx.plugin(MemorySettings).await()
  applyWithSettings(ctx, {
    modelsByRegion: {
      global: [{
        id: 'tiered', name: 'Tiered', contextWindow: 200_000, contextTier: 'large',
        contextOptions: {
          small: { tokenCount: 200_000, isDefault: true },
          large: { tokenCount: 1_000_000 },
        },
      }],
    },
  })

  const prepared = await ctx.llm.prepareCall({ provider: QODER_PROVIDER_ID, model: 'tiered' })
  assert.equal(prepared.context?.contextWindow, 1_000_000)
})

test('the settings round-trip keeps a context tier selection', async () => {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(TestCredentials)
  await ctx.plugin(MemorySettings).await()
  applyWithSettings(ctx, {})
  await ctx.fiber.await()
  const ns = 'provider-qoder' as SettingsNamespace

  await ctx.settings.update(ns, {
    modelsByRegion: {
      global: [{
        id: 'tiered', name: 'Tiered', contextWindow: 1_000_000, contextTier: 'large',
        contextOptions: {
          small: { tokenCount: 200_000, isDefault: true },
          large: { tokenCount: 1_000_000 },
        },
      }],
    },
  })

  const stored = memorySettings(ctx).get(ns) as plugin.Config
  assert.equal(stored.modelsByRegion?.global?.[0].contextTier, 'large')
  assert.equal(
    (await ctx.llm.prepareCall({ provider: QODER_PROVIDER_ID, model: 'tiered' })).context?.contextWindow,
    1_000_000,
  )
})

test('the settings service tolerates updates with frozen models containing contextOptions', async () => {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(TestCredentials)
  await ctx.plugin(MemorySettings).await()
  applyWithSettings(ctx, {})
  await ctx.fiber.await()
  const ns = 'provider-qoder' as SettingsNamespace

  const frozenModels = Object.freeze([{
    id: 'tiered', name: 'Tiered', contextWindow: 1_000_000, contextTier: '1M',
    contextOptions: Object.freeze({
      '200K': Object.freeze({ tokenCount: 200_000, isDefault: false }),
      '1M': Object.freeze({ tokenCount: 1_000_000, isDefault: true }),
    }),
  }])

  await ctx.settings.update(ns, {
    modelsByRegion: {
      global: frozenModels,
    },
  })

  const stored = memorySettings(ctx).get(ns) as plugin.Config
  assert.equal(stored.modelsByRegion?.global?.[0].contextTier, '1M')

  // Updating again with the frozen resolved snapshot value must not throw Cannot assign to read only property '1M'
  await ctx.settings.update(ns, {
    modelsByRegion: {
      global: stored.modelsByRegion!.global!,
    },
  })
  assert.equal(
    (await ctx.llm.prepareCall({ provider: QODER_PROVIDER_ID, model: 'tiered' })).context?.contextWindow,
    1_000_000,
  )
})
