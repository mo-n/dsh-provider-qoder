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
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import * as plugin from '../src/index.ts'

class MemorySettings extends SettingsProvider {
  readonly writable = true

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve({})
  }

  protected persist(_ns: SettingsNamespace, _section: Record<string, unknown>): Promise<void> {
    return Promise.resolve()
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
  assert.equal('apiKeyEnv' in plugin.Config({}), false)
})

test('apply registers a valid adapter with the real DSH runtime', async () => {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(TestCredentials)
  await ctx.plugin(MemorySettings).await()
  plugin.apply(ctx, {})
  assert.equal(
    ctx.llm.listConfigurableProviders().some(provider => provider.provider === 'qoder-official'),
    false,
  )
  const models = await ctx.llm.listModels('qoder-official')
  assert.ok(models.length > 1)
  assert.ok(models.some(model => model.id === 'cmodel'))
  assert.ok(models.some(model => model.id === 'auto'))
  assert.deepEqual(ctx.llm.providerRetryPolicy('qoder-official'), {
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
    (await ctx.llm.listModels('qoder-official')).map(model => model.id),
    ['custom-qoder'],
  )
  await ctx.settings.update('provider-qoder' as SettingsNamespace, { region: 'china' })
  assert.ok((await ctx.llm.listModels('qoder-official')).some(model => model.id === 'cmodel'))
  assert.equal((await ctx.llm.listModels('qoder-official')).some(model => model.id === 'custom-qoder'), false)
  await ctx.settings.update('provider-qoder' as SettingsNamespace, {
    modelsByRegion: {
      global: [{ id: 'custom-qoder', name: 'Custom Qoder' }],
      china: [{ id: 'china-qoder', name: 'China Qoder' }],
    },
  })
  assert.deepEqual((await ctx.llm.listModels('qoder-official')).map(model => model.id), ['china-qoder'])
  await ctx.settings.update('provider-qoder' as SettingsNamespace, { region: 'global' })
  assert.deepEqual((await ctx.llm.listModels('qoder-official')).map(model => model.id), ['custom-qoder'])
  const prepared = await ctx.llm.prepareCall({ provider: 'qoder-official', model: 'cmodel' })
  assert.equal(prepared.config.provider, 'qoder-official')
  assert.equal(prepared.config.model, 'cmodel')
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

  assert.deepEqual((await ctx.llm.listModels('qoder-official')).map(model => model.id), ['legacy-china'])
  await ctx.settings.update('provider-qoder' as SettingsNamespace, { region: 'global' })
  assert.ok((await ctx.llm.listModels('qoder-official')).some(model => model.id === 'cmodel'))
  assert.equal((await ctx.llm.listModels('qoder-official')).some(model => model.id === 'legacy-china'), false)
})

test('apply succeeds with default Config schema and empty models array', async () => {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(TestCredentials)
  await ctx.plugin(MemorySettings).await()
  const normalizedConfig = plugin.Config({})
  assert.deepEqual(normalizedConfig.models, [])
  plugin.apply(ctx, normalizedConfig)
  const models = await ctx.llm.listModels('qoder-official')
  assert.ok(models.length > 0)
  assert.ok(models.some(model => model.id === 'cmodel'))

  const ctxEmptyModels = new Context()
  await ctxEmptyModels.plugin(LlmRuntime)
  await ctxEmptyModels.plugin(TestCredentials)
  await ctxEmptyModels.plugin(MemorySettings).await()
  plugin.apply(ctxEmptyModels, { models: [] })
  const fallbackModels = await ctxEmptyModels.llm.listModels('qoder-official')
  assert.ok(fallbackModels.length > 0)
  assert.ok(fallbackModels.some(model => model.id === 'cmodel'))
})

