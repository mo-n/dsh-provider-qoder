/** Register the Global Qoder subscription provider with DSH. */

import type { Context, FiberState } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import {
  defaultModels,
  defaultStreamIdleTimeoutMs,
  QoderAdapter,
  type QoderCatalogModel,
} from './adapter.ts'
import { QoderAuthService } from './auth.ts'
import { resolveManagedQoderPat } from './credential.ts'
import { QoderLlmError } from './errors.ts'
import { redactLogValue, type QoderLogger } from './logging.ts'
import {
  fetchQoderModels,
  hasSameQoderDiscoveryMetadata,
  mergeQoderDiscoveryMetadata,
} from './models.ts'
import type { QoderRegion } from './endpoints.ts'
import { QoderUsageReader } from './usage.ts'

export * from './adapter.ts'
export * from './auth.ts'
export * from './cosy.ts'
export * from './credential-contract.ts'
export * from './credential.ts'
export * from './encoding.ts'
export * from './endpoints.ts'
export * from './errors.ts'
export * from './machine-id.ts'
export * from './logging.ts'
export * from './models.ts'
export * from './serialize.ts'
export * from './sse.ts'
export * from './translate.ts'
export * from './types.ts'
export * from './usage.ts'

export const name = 'provider-qoder'
export const inject = ['llm', 'credentials', 'connection']

const providerQoder = 'qoder-official'
const settingsNamespace = 'provider-qoder' as SettingsNamespace
const qoderChannel = '/qoder-subscription'
const fiberDisposed: FiberState = 4
const fiberUnloading: FiberState = 5

export interface Config {
  region?: QoderRegion
  models?: QoderCatalogModel[]
  streamIdleTimeoutMs?: number
}

const catalogModel: z<QoderCatalogModel> = z.object({
  id: z.string().required(),
  name: z.string().required(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  source: z.string(),
  isReasoning: z.boolean(),
  supportsEffort: z.boolean(),
  reasoningEfforts: z.array(z.object({
    id: z.string().required(),
    name: z.string().required(),
    description: z.string(),
  })),
  defaultReasoningEffort: z.string(),
  priceFactor: z.number().min(0),
  contextOptions: z.dict(z.object({
    tokenCount: z.number().step(1).min(1),
    isDefault: z.boolean(),
  })),
})

export const Config: z<Config> = z.object({
  region: z.union(['global', 'china'] as const).default('global'),
  models: z.array(catalogModel).default(defaultModels),
  streamIdleTimeoutMs: z.number().step(1).min(1).default(defaultStreamIdleTimeoutMs),
})

function resolveModels(models: readonly QoderCatalogModel[] | undefined): QoderCatalogModel[] {
  const resolved = models ?? defaultModels
  if (resolved.length === 0) throw new Error('provider-qoder: at least one model is required')
  const seen = new Set<string>()
  return resolved.map((model) => {
    if (!model.id || !model.name) throw new Error('provider-qoder: model id and name must be non-empty')
    if (seen.has(model.id)) throw new Error(`provider-qoder: duplicate model id "${model.id}"`)
    seen.add(model.id)
    return { ...model }
  })
}

function publicError(message: string) {
  return {
    ok: false as const,
    error: { code: 'internal' as const, message, details: { issues: [] } },
  }
}

export function apply(ctx: Context, config: Config = {}): void {
  const logger = (ctx as Context & { logger?: QoderLogger }).logger
  let current = (): Config => baseConfig
  const authService = new QoderAuthService({
    logger,
    resolveRegion: () => current().region ?? 'global',
  })
  const usageReader = new QoderUsageReader({
    authService,
    logger,
    resolveRegion: () => current().region ?? 'global',
  })

  const baseConfig: Config = {
    region: config.region ?? 'global',
    models: resolveModels(config.models),
    streamIdleTimeoutMs: config.streamIdleTimeoutMs ?? defaultStreamIdleTimeoutMs,
  }
  let discoveredCatalog: readonly QoderCatalogModel[] = []
  let previousRegion = baseConfig.region ?? 'global'
  const resolveConfig = () => ({
    region: current().region ?? 'global',
    models: mergeQoderDiscoveryMetadata(resolveModels(current().models), discoveredCatalog),
    streamIdleTimeoutMs: current().streamIdleTimeoutMs ?? defaultStreamIdleTimeoutMs,
  })
  const initial = resolveConfig()
  const adapter = new QoderAdapter({
    resolvePat: () => resolveManagedQoderPat(ctx.credentials),
    models: initial.models,
    providerId: providerQoder,
    providerName: 'Qoder',
    authService,
    logger,
    streamIdleTimeoutMs: initial.streamIdleTimeoutMs,
    region: initial.region,
  })

  const registration = ctx.llm.registerAdapter([providerQoder], adapter)
  const refreshAdapter = (): void => {
    const next = resolveConfig()
    if (next.region !== previousRegion) {
      authService.clear()
      usageReader.clear()
      previousRegion = next.region
    }
    adapter.replaceConfig(next.models, next.streamIdleTimeoutMs, next.region)
    registration.replace([providerQoder])
  }

  ctx.inject(['settings'], (settingsCtx) => {
    const scope = settingsCtx.settings.register(settingsNamespace, Config, {
      base: baseConfig,
      validate: value => { resolveModels(value.models) },
    })
    current = () => scope.get()
    refreshAdapter()
    scope.watch(async (next) => {
      if (ctx.fiber.state === fiberUnloading || ctx.fiber.state === fiberDisposed) return
      refreshAdapter()
      const enriched = mergeQoderDiscoveryMetadata(resolveModels(next.models), discoveredCatalog)
      if (!hasSameQoderDiscoveryMetadata(next.models, enriched)) {
        await scope.update({ models: enriched })
      }
    })
    settingsCtx.effect(() => () => {
      if (ctx.fiber.state === fiberUnloading || ctx.fiber.state === fiberDisposed) return
      current = () => baseConfig
      refreshAdapter()
    })
  })

  const discoverModels = async (signal?: AbortSignal, suppliedPat?: string): Promise<QoderCatalogModel[]> => {
    const pat = suppliedPat?.trim() || await resolveManagedQoderPat(ctx.credentials)
    if (!pat) throw new QoderLlmError('Qoder PAT is not configured.', 'MISSING_CREDENTIAL')
    const region = current().region ?? 'global'
    const credentials = await authService.getCredentials(pat, signal, region)
    const models = await fetchQoderModels(credentials, { signal, logger, region })
    discoveredCatalog = models
    return models
  }

  ctx.llm.registerModelDiscovery(settingsNamespace, async (request, signal) => {
    if (request.provider !== undefined && request.provider !== providerQoder) {
      throw new QoderLlmError(`Qoder discovery does not own provider "${request.provider}".`, 'INVALID_PROVIDER')
    }
    return (await discoverModels(signal, request.apiKey)).map(model => ({
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    }))
  })

  if (ctx.connection?.rpc) {
    const handler: ConnectionRpcHandler = async (endpoint, payload, signal) => {
      if (endpoint !== 'account' && endpoint !== 'models') return publicError(`Unknown endpoint: ${endpoint}`)
      signal.throwIfAborted()
      if (endpoint === 'models') {
        try {
          return { ok: true, value: await discoverModels(signal) }
        } catch (error) {
          if (signal.aborted || (error instanceof QoderLlmError && error.code === 'ABORTED')) throw error
          logger?.error?.('[Qoder RPC] Failed to discover models', redactLogValue(error))
          return publicError(error instanceof Error ? error.message : 'Failed to discover Qoder models')
        }
      }
      const force = typeof payload === 'object' && payload !== null && 'force' in payload
        ? payload.force === true
        : false
      logger?.debug?.('[Qoder RPC] Reading subscriber account', { force })

      let pat: string
      try {
        pat = await resolveManagedQoderPat(ctx.credentials)
      } catch (error) {
        if (signal.aborted) throw error
        logger?.error?.('[Qoder RPC] Failed to resolve managed PAT', redactLogValue(error))
        return publicError(error instanceof Error ? error.message : 'No Qoder PAT configured')
      }
      if (!pat) {
        logger?.warn?.('[Qoder RPC] No managed Qoder PAT is configured')
        return publicError('Qoder PAT is not configured')
      }

      try {
        const account = await usageReader.readAccount(pat, { force, signal, region: current().region ?? 'global' })
        logger?.debug?.('[Qoder RPC] Subscriber account resolved')
        return { ok: true, value: account }
      } catch (error) {
        if (signal.aborted || (error instanceof QoderLlmError && error.code === 'ABORTED')) throw error
        logger?.error?.('[Qoder RPC] Failed to read subscriber account', redactLogValue(error))
        return publicError(error instanceof Error ? error.message : 'Failed to load Qoder account')
      }
    }

    ctx.effect(
      () => ctx.connection.rpc.handle(qoderChannel, handler),
      'provider-qoder: loopback account RPC',
    )
  }
}
