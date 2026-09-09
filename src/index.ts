/** Register the Qoder subscription provider with DSH. */

import type { Context, FiberState } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { QoderAdapter } from './adapter.ts'
import { defaultModels, type QoderCatalogModel } from './catalog.ts'
import { resolveManagedQoderPat } from './credential.ts'
import type { QoderRegion } from './endpoints.ts'
import { QoderLlmError } from './errors.ts'
import { redactLogValue, type QoderLogger } from './logging.ts'
import {
  hasSameQoderDiscoveryMetadata,
  mergeQoderDiscoveryMetadata,
} from './models.ts'
import {
  createQoderTransport,
  defaultStreamIdleTimeoutMs,
  type QoderTransport,
} from './transport.ts'
import type { QoderAccountInfo } from './usage.ts'

export type { QoderCatalogModel } from './catalog.ts'
export type { QoderRegion } from './endpoints.ts'
export type { QoderAccountInfo } from './usage.ts'

export const name = 'provider-qoder'
export const inject = ['llm', 'credentials', 'connection']

const providerQoder = 'qoder-official'
const settingsNamespace = 'provider-qoder' as SettingsNamespace
const qoderChannel = '/qoder-subscription'
const fiberDisposed: FiberState = 4
const fiberUnloading: FiberState = 5

export interface QoderModelsByRegion {
  global?: QoderCatalogModel[]
  china?: QoderCatalogModel[]
}

export interface Config {
  region?: QoderRegion
  modelsByRegion?: QoderModelsByRegion
  /** @deprecated Migrated to modelsByRegion for the selected region. */
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

const modelsByRegionSchema = z.dict(z.array(catalogModel)) as z<QoderModelsByRegion>

export const Config: z<Config> = z.object({
  region: z.union(['global', 'china'] as const).default('global'),
  modelsByRegion: modelsByRegionSchema.default({}),
  models: z.array(catalogModel),
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

function modelsFor(
  config: Config,
  region: QoderRegion,
  legacyModelsRegion: QoderRegion = config.region ?? 'global',
): QoderCatalogModel[] {
  const scoped = config.modelsByRegion?.[region]
  if (scoped !== undefined) return resolveModels(scoped)
  if (legacyModelsRegion === region && config.models !== undefined && config.models.length > 0) {
    return resolveModels(config.models)
  }
  return resolveModels(defaultModels)
}

function publicError(message: string) {
  return {
    ok: false as const,
    error: { code: 'internal' as const, message, details: { issues: [] } },
  }
}

export function apply(ctx: Context, config: Config = {}): void {
  const logger = (ctx as Context & { logger?: QoderLogger }).logger
  const initialRegion = config.region ?? 'global'
  const baseConfig: Config = {
    region: initialRegion,
    modelsByRegion: { ...config.modelsByRegion },
    ...config.models === undefined ? {} : { models: resolveModels(config.models) },
    streamIdleTimeoutMs: config.streamIdleTimeoutMs ?? defaultStreamIdleTimeoutMs,
  }
  let current = (): Config => baseConfig
  let legacyModelsRegion = initialRegion
  const discoveredCatalogs: Record<QoderRegion, readonly QoderCatalogModel[]> = {
    global: [],
    china: [],
  }

  const createTransport = (
    region: QoderRegion,
    streamIdleTimeoutMs: number,
    resolvePat: () => Promise<string> = () => resolveManagedQoderPat(ctx.credentials),
  ): QoderTransport => createQoderTransport({
    region,
    resolvePat,
    logger,
    streamIdleTimeoutMs,
  })

  const resolveConfig = () => {
    const value = current()
    const region = value.region ?? 'global'
    return {
      region,
      models: mergeQoderDiscoveryMetadata(
        modelsFor(value, region, legacyModelsRegion),
        discoveredCatalogs[region],
      ),
      streamIdleTimeoutMs: value.streamIdleTimeoutMs ?? defaultStreamIdleTimeoutMs,
    }
  }

  const initial = resolveConfig()
  let activeTransport = createTransport(initial.region, initial.streamIdleTimeoutMs)
  let activeTransportConfig = {
    region: initial.region,
    streamIdleTimeoutMs: initial.streamIdleTimeoutMs,
  }
  const adapter = new QoderAdapter({
    resolveTransport: () => activeTransport,
    models: initial.models,
    providerId: providerQoder,
    providerName: 'Qoder',
  })

  const registration = ctx.llm.registerAdapter([providerQoder], adapter)
  const refreshAdapter = (): void => {
    const next = resolveConfig()
    if (next.region !== activeTransportConfig.region
      || next.streamIdleTimeoutMs !== activeTransportConfig.streamIdleTimeoutMs) {
      activeTransport = createTransport(next.region, next.streamIdleTimeoutMs)
      activeTransportConfig = {
        region: next.region,
        streamIdleTimeoutMs: next.streamIdleTimeoutMs,
      }
    }
    adapter.replaceModels(next.models)
    registration.replace([providerQoder])
  }

  ctx.inject(['settings'], (settingsCtx) => {
    const scope = settingsCtx.settings.register(settingsNamespace, Config, {
      base: baseConfig,
      validate: (value) => {
        for (const region of Object.keys(value.modelsByRegion ?? {})) {
          if (region !== 'global' && region !== 'china') {
            throw new Error(`provider-qoder: unsupported model catalog region "${region}"`)
          }
        }
        modelsFor(value, 'global', legacyModelsRegion)
        modelsFor(value, 'china', legacyModelsRegion)
      },
    })
    legacyModelsRegion = scope.get().region ?? initialRegion
    current = () => scope.get()
    refreshAdapter()

    const loaded = scope.get()
    const loadedRegion = loaded.region ?? 'global'
    if (loaded.models !== undefined && loaded.models.length > 0
      && loaded.modelsByRegion?.[loadedRegion] === undefined) {
      void scope.update({
        modelsByRegion: {
          ...loaded.modelsByRegion,
          [loadedRegion]: resolveModels(loaded.models),
        },
      }).catch(error => logger?.error?.('[Qoder Settings] Failed to migrate model catalog', redactLogValue(error)))
    }

    scope.watch(async (next) => {
      if (ctx.fiber.state === fiberUnloading || ctx.fiber.state === fiberDisposed) return
      refreshAdapter()
      const region = next.region ?? 'global'
      const selected = modelsFor(next, region, legacyModelsRegion)
      const enriched = mergeQoderDiscoveryMetadata(selected, discoveredCatalogs[region])
      if (!hasSameQoderDiscoveryMetadata(selected, enriched)) {
        await scope.update({
          modelsByRegion: { ...next.modelsByRegion, [region]: enriched },
        })
      }
    })
    settingsCtx.effect(() => () => {
      if (ctx.fiber.state === fiberUnloading || ctx.fiber.state === fiberDisposed) return
      current = () => baseConfig
      refreshAdapter()
    })
  })

  const discoverModels = async (signal?: AbortSignal, suppliedPat?: string): Promise<readonly QoderCatalogModel[]> => {
    const snapshot = resolveConfig()
    const normalizedPat = suppliedPat?.trim()
    const transport = normalizedPat
      ? createTransport(snapshot.region, snapshot.streamIdleTimeoutMs, () => Promise.resolve(normalizedPat))
      : activeTransport
    const models = await transport.discoverModels(signal)
    discoveredCatalogs[snapshot.region] = models
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
      try {
        const account = await activeTransport.readAccount({ force, signal })
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
