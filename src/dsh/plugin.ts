/** Register the Qoder subscription provider with DSH. */

import type { Context, FiberState } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-attachment'
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { QoderAdapter } from './adapter.ts'
import {
  hasSameQoderDiscoveryMetadata,
  mergeQoderDiscoveryMetadata,
  type QoderCatalogModel,
} from '../qoder/catalog.ts'
import { resolveManagedQoderPat } from './credential.ts'
import type { QoderRegion } from '../qoder/region.ts'
import { QoderLlmError } from '../qoder/errors.ts'
import {
  createQoderTransport,
  defaultStreamIdleTimeoutMs,
  type QoderTransport,
  type QoderTransportOptions,
} from '../qoder/transport/index.ts'
import { Config, modelsFor, resolveModels, type Config as QoderConfig } from './config.ts'

export const name = 'provider-qoder'
export const inject = ['llm', 'credentials', 'connection', 'attachments']

const providerQoder = 'qoder-official'
const settingsNamespace = 'provider-qoder' as SettingsNamespace
const qoderChannel = '/qoder-subscription'
const fiberDisposed: FiberState = 4
const fiberUnloading: FiberState = 5

type QoderLogger = NonNullable<QoderTransportOptions['logger']>

function logError(error: unknown): unknown {
  if (!(error instanceof Error)) return { name: 'UnknownError' }
  return {
    name: error.name,
    message: error.message,
    ...'code' in error ? { code: error.code } : {},
  }
}

function publicError(message: string) {
  return {
    ok: false as const,
    error: { code: 'internal' as const, message, details: { issues: [] } },
  }
}

export function apply(ctx: Context, config: QoderConfig = {}): void {
  const logger = (ctx as Context & { logger?: QoderLogger }).logger
  const initialRegion = config.region ?? 'global'
  const hasConfiguredModels = config.models !== undefined && config.models.length > 0
  const baseConfig: QoderConfig = {
    region: initialRegion,
    modelsByRegion: { ...config.modelsByRegion },
    ...hasConfiguredModels ? { models: resolveModels(config.models) } : {},
    streamIdleTimeoutMs: config.streamIdleTimeoutMs ?? defaultStreamIdleTimeoutMs,
    preserveThinking: config.preserveThinking ?? true,
  }
  let current = (): QoderConfig => baseConfig
  let legacyModelsRegion = initialRegion
  let persistDiscoveredModels = async (_region: QoderRegion): Promise<void> => {}
  const discoveredCatalogs: Record<QoderRegion, readonly QoderCatalogModel[]> = {
    global: [],
    china: [],
  }

  const createTransport = (
    region: QoderRegion,
    streamIdleTimeoutMs: number,
    preserveThinking: boolean,
    resolvePat: () => Promise<string> = () => resolveManagedQoderPat(ctx.credentials),
  ): QoderTransport => createQoderTransport({
    region,
    resolvePat,
    logger,
    streamIdleTimeoutMs,
    attachments: ctx.attachments,
    preserveThinking,
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
      preserveThinking: value.preserveThinking ?? true,
    }
  }

  const initial = resolveConfig()
  let activeTransport = createTransport(initial.region, initial.streamIdleTimeoutMs, initial.preserveThinking)
  let activeTransportConfig = {
    region: initial.region,
    streamIdleTimeoutMs: initial.streamIdleTimeoutMs,
    preserveThinking: initial.preserveThinking,
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
      || next.streamIdleTimeoutMs !== activeTransportConfig.streamIdleTimeoutMs
      || next.preserveThinking !== activeTransportConfig.preserveThinking) {
      activeTransport = createTransport(next.region, next.streamIdleTimeoutMs, next.preserveThinking)
      activeTransportConfig = {
        region: next.region,
        streamIdleTimeoutMs: next.streamIdleTimeoutMs,
        preserveThinking: next.preserveThinking,
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
    persistDiscoveredModels = async (region) => {
      const value = scope.get()
      const selected = modelsFor(value, region, legacyModelsRegion)
      const enriched = mergeQoderDiscoveryMetadata(selected, discoveredCatalogs[region])
      if (!hasSameQoderDiscoveryMetadata(selected, enriched)) {
        await scope.update({ modelsByRegion: { ...value.modelsByRegion, [region]: enriched } })
      }
    }
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
      }).catch(error => logger?.error?.('[Qoder Settings] Failed to migrate model catalog', logError(error)))
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
      persistDiscoveredModels = async () => {}
      current = () => baseConfig
      refreshAdapter()
    })
  })

  const discoverModels = async (signal?: AbortSignal, suppliedPat?: string): Promise<readonly QoderCatalogModel[]> => {
    const snapshot = resolveConfig()
    const normalizedPat = suppliedPat?.trim()
    const transport = normalizedPat
      ? createTransport(snapshot.region, snapshot.streamIdleTimeoutMs, snapshot.preserveThinking, () => Promise.resolve(normalizedPat))
      : activeTransport
    const models = await transport.discoverModels(signal)
    discoveredCatalogs[snapshot.region] = models
    refreshAdapter()
    await persistDiscoveredModels(snapshot.region)
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
          logger?.error?.('[Qoder RPC] Failed to discover models', logError(error))
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
        logger?.error?.('[Qoder RPC] Failed to read subscriber account', logError(error))
        return publicError(error instanceof Error ? error.message : 'Failed to load Qoder account')
      }
    }

    ctx.inject(['webServer'], (webCtx) => {
      webCtx.effect(
        () => webCtx.connection.rpc.handle(qoderChannel, handler),
        'provider-qoder: loopback account RPC',
      )
    })
  }
}
