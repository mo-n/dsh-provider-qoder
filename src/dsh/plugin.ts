/** Register the Qoder subscription provider with DSH. */

import type { Context, FiberState } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-web'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { QoderAdapter } from './adapter.ts'
import { QODER_PROVIDER_ID } from './provider.ts'
import { initiatingModelProvider, QoderSearchProvider, shouldUseQoderSearch } from './search-provider.ts'
import { QoderCatalogLifecycle } from './catalog-lifecycle.ts'
import type { QoderCatalogModel } from '../qoder/catalog.ts'
import { resolveManagedQoderPat } from './credential.ts'
import type { QoderRegion } from '../qoder/region.ts'
import { QoderLlmError } from '../qoder/errors.ts'
import {
  createQoderTransport,
  defaultResponseHeaderTimeoutMs,
  defaultStreamIdleTimeoutMs,
  type QoderTransport,
  type QoderTransportOptions,
} from '../qoder/transport/index.ts'
import { modelsFor, readConfig, type Config as QoderConfig, type LiveConfig } from './config.ts'
import { bindQoderSettings } from './settings.ts'
import { isQoderRpcEndpoint, type QoderRpcErrorCode } from './rpc-channel.ts'
import { registerQoderRpc, type QoderRpcHandler } from './rpc.ts'

export const name = 'provider-qoder'
export const inject = ['llm', 'credentials', 'connection', 'attachments']

const providerQoder = QODER_PROVIDER_ID
const settingsNamespace = 'provider-qoder' as SettingsNamespace
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

type QoderHostRpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: QoderRpcErrorCode; readonly message: string; readonly details: object } }

function publicError(code: QoderRpcErrorCode, message: string, details: object = { issues: [] }): QoderHostRpcResult<never> {
  return {
    ok: false,
    error: { code, message, details },
  }
}

async function executeRpc<T>(
  operation: string,
  task: () => Promise<T>,
  signal: AbortSignal,
  logger?: QoderLogger,
): Promise<QoderHostRpcResult<T>> {
  try {
    return { ok: true, value: await task() }
  } catch (error) {
    if (signal.aborted || (error instanceof QoderLlmError && error.code === 'ABORTED')) {
      logger?.debug?.(`[Qoder RPC] ${operation} was aborted`)
      return publicError('ABORTED', 'Request aborted')
    }
    let code: QoderRpcErrorCode = 'INTERNAL'
    if (error instanceof QoderLlmError) {
      if (error.code === 'MISSING_CREDENTIAL' || error.code === 'NO_CREDENTIALS') {
        code = 'NO_CREDENTIALS'
      } else if (error.code === 'AUTH') {
        code = 'UNAUTHENTICATED'
      } else if (error.code === 'TIMEOUT') {
        code = 'TIMEOUT'
      } else {
        code = 'UPSTREAM_ERROR'
      }
    }
    logger?.error?.(`[Qoder RPC] Failed to ${operation}`, logError(error))
    return publicError(code, error instanceof Error ? error.message : `Failed to ${operation}`)
  }
}

export function apply(ctx: Context, input: QoderConfig | LiveConfig = {}): void {
  const config = readConfig(input)
  const logger = (ctx as Context & { logger?: QoderLogger }).logger
  const initialRegion = config.region ?? 'global'
  const baseConfig: QoderConfig = {
    region: initialRegion,
    modelsByRegion: { ...config.modelsByRegion },
    streamIdleTimeoutMs: config.streamIdleTimeoutMs ?? defaultStreamIdleTimeoutMs,
    responseHeaderTimeoutMs: config.responseHeaderTimeoutMs ?? defaultResponseHeaderTimeoutMs,
    preserveThinking: config.preserveThinking ?? true,
    webSearchMode: config.webSearchMode ?? 'auto',
  }
  let current = (): QoderConfig => baseConfig
  const createTransport = (
    region: QoderRegion,
    streamIdleTimeoutMs: number,
    responseHeaderTimeoutMs: number,
    preserveThinking: boolean,
    resolvePat: () => Promise<string> = () => resolveManagedQoderPat(ctx.credentials),
  ): QoderTransport => createQoderTransport({
    region,
    resolvePat,
    logger,
    streamIdleTimeoutMs,
    responseHeaderTimeoutMs,
    attachments: ctx.attachments,
    preserveThinking,
  })

  const resolveConfig = () => {
    const value = current()
    const region = value.region ?? 'global'
    return {
      region,
      models: modelsFor(value, region),
      streamIdleTimeoutMs: value.streamIdleTimeoutMs ?? defaultStreamIdleTimeoutMs,
      responseHeaderTimeoutMs: value.responseHeaderTimeoutMs ?? defaultResponseHeaderTimeoutMs,
      preserveThinking: value.preserveThinking ?? true,
      webSearchMode: value.webSearchMode ?? 'auto',
    }
  }

  const initial = resolveConfig()
  let activeTransport = createTransport(
    initial.region,
    initial.streamIdleTimeoutMs,
    initial.responseHeaderTimeoutMs,
    initial.preserveThinking,
  )
  let activeTransportConfig = {
    region: initial.region,
    streamIdleTimeoutMs: initial.streamIdleTimeoutMs,
    responseHeaderTimeoutMs: initial.responseHeaderTimeoutMs,
    preserveThinking: initial.preserveThinking,
  }
  const catalog = new QoderCatalogLifecycle({
    resolveTransport: () => activeTransport,
    region: () => activeTransportConfig.region,
    configuredModels: region => modelsFor(current(), region),
    onDiscovered: () => registration.replace([providerQoder]),
    onPersistenceError: error => logger?.error?.('[Qoder Settings] Failed to synchronize model catalog', logError(error)),
  })
  ctx.effect(() => () => catalog.dispose(), 'provider-qoder: catalog lifecycle')
  const adapter = new QoderAdapter({
    resolveTransport: () => activeTransport,
    catalog,
    region: () => activeTransportConfig.region,
    providerId: providerQoder,
    providerName: 'Qoder',
    sessions: ctx.get('sessions') as import('./adapter.ts').QoderAdapterSessionStore | undefined,
    agents: ctx.get('agents') as import('./adapter.ts').QoderAdapterAgentStore | undefined,
  })

  const registration = ctx.llm.registerAdapter([providerQoder], adapter)
  const refreshAdapter = (): void => {
    const next = resolveConfig()
    if (next.region !== activeTransportConfig.region
      || next.streamIdleTimeoutMs !== activeTransportConfig.streamIdleTimeoutMs
      || next.responseHeaderTimeoutMs !== activeTransportConfig.responseHeaderTimeoutMs
      || next.preserveThinking !== activeTransportConfig.preserveThinking) {
      activeTransport = createTransport(
        next.region,
        next.streamIdleTimeoutMs,
        next.responseHeaderTimeoutMs,
        next.preserveThinking,
      )
      activeTransportConfig = {
        region: next.region,
        streamIdleTimeoutMs: next.streamIdleTimeoutMs,
        responseHeaderTimeoutMs: next.responseHeaderTimeoutMs,
        preserveThinking: next.preserveThinking,
      }
    }
    catalog.observeTransport()
    adapter.replaceModels(next.models)
    registration.replace([providerQoder])
  }

  ctx.inject(['settings'], (settingsCtx) => {
    const { scope, namespace } = bindQoderSettings(ctx, settingsCtx, input, {
      validate: (value) => {
        for (const region of Object.keys(value.modelsByRegion ?? {})) {
          if (region !== 'global' && region !== 'china') {
            throw new Error(`provider-qoder: unsupported model catalog region "${region}"`)
          }
        }
        modelsFor(value, 'global')
        modelsFor(value, 'china')
      },
    })
    current = () => scope.get()
    catalog.bindSettings({
      read: region => {
        if (!settingsCtx.settings.writable) return undefined
        const snapshot = settingsCtx.settings.describe().find(section => section.ns === namespace)
        return snapshot === undefined ? undefined : {
          models: modelsFor(snapshot.value as QoderConfig, region), revision: snapshot.revision,
        }
      },
      write: (region, models, revision) => settingsCtx.settings.update(namespace, {
        modelsByRegion: { [region]: models },
      }, revision),
    })
    refreshAdapter()
    scope.watch(() => {
      if (ctx.fiber.state === fiberUnloading || ctx.fiber.state === fiberDisposed) return
      refreshAdapter()
      catalog.retryPersistence()
    })
    settingsCtx.effect(() => () => {
      catalog.bindSettings(undefined)
      if (ctx.fiber.state === fiberUnloading || ctx.fiber.state === fiberDisposed) return
      current = () => baseConfig
      refreshAdapter()
    })
  })

  const discoverModels = async (signal?: AbortSignal, suppliedPat?: string): Promise<readonly QoderCatalogModel[]> => {
    const snapshot = resolveConfig()
    const normalizedPat = suppliedPat?.trim()
    const transport = normalizedPat
      ? createTransport(
          snapshot.region,
          snapshot.streamIdleTimeoutMs,
          snapshot.responseHeaderTimeoutMs,
          snapshot.preserveThinking,
          () => Promise.resolve(normalizedPat),
        )
      : activeTransport
    return catalog.discover(signal, transport)
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

  const handler: QoderRpcHandler = async (endpoint, payload, signal) => {
    if (!isQoderRpcEndpoint(endpoint)) return publicError('UNKNOWN_ENDPOINT', `Unknown endpoint: ${endpoint}`)
    if (signal.aborted) return publicError('ABORTED', 'Request aborted')

    if (endpoint === 'models') {
      return await executeRpc('discover Qoder models', () => discoverModels(signal), signal, logger)
    }

    if (endpoint === 'sessionTier') {
      const data = payload as { sessionId?: string; modelId?: string; tierKey?: string; region?: QoderRegion }
      if (typeof data?.sessionId === 'string' && typeof data?.modelId === 'string' && typeof data?.tierKey === 'string' && (data.region === 'global' || data.region === 'china')) {
        const { sessionId, modelId, tierKey, region } = data
        return await executeRpc('select session context tier', async () => {
          adapter.setSessionTier(sessionId, modelId, tierKey, region)
          return { success: true }
        }, signal, logger)
      }
      return publicError('INTERNAL', 'Invalid sessionTier payload')
    }

    const force = typeof payload === 'object' && payload !== null && 'force' in payload
      ? payload.force === true
      : false
    logger?.debug?.('[Qoder RPC] Reading subscriber account', { force })
    const outcome = await executeRpc(
      'load Qoder account',
      () => activeTransport.readAccount({ force, signal }),
      signal,
      logger,
    )
    if (outcome.ok) logger?.debug?.('[Qoder RPC] Subscriber account resolved')
    return outcome
  }

  try {
    ctx.effect(() => registerQoderRpc(ctx, handler), 'provider-qoder: settings RPC routes')
  } catch (error) {
    // The settings RPC is an optional surface: a registration failure must not
    // take the model adapter or the web-search router down with it.
    logger?.error?.('[Qoder RPC] Failed to register the settings RPC routes', logError(error))
  }

  ctx.inject(['web'], (webCtx) => {
    const searchProvider = new QoderSearchProvider({
      ctx,
      resolveTransport: () => activeTransport,
      getWebSearchMode: () => resolveConfig().webSearchMode ?? 'auto',
    })
    webCtx.web.registerSearchProvider(searchProvider)

    // Transparent interceptor: ensure that when a Qoder model is active,
    // ctx.web.search always routes to Qoder even if the host profile configured
    // a different fixed searchProvider (e.g. deepseek-official).
    if (typeof webCtx.web.search === 'function') {
      const originalSearch = webCtx.web.search
      webCtx.effect(() => {
        const routedSearch: typeof originalSearch = async (request, signal) => {
          const mode = resolveConfig().webSearchMode ?? 'auto'
          if (shouldUseQoderSearch(mode, initiatingModelProvider(ctx))) {
            return searchProvider.search(request, signal)
          }
          return originalSearch.call(webCtx.web, request, signal)
        }
        webCtx.web.search = routedSearch
        return () => {
          if (webCtx.web.search === routedSearch) webCtx.web.search = originalSearch
        }
      }, 'provider-qoder: transparent web search router')
    }
  })
}
