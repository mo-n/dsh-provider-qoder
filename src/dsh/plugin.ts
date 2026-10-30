/** Register the Qoder subscription provider with DSH. */

import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { QoderQueueLeases, bindQoderQueueLeases } from './queue-leases.ts'
import { QoderQueueStatusStore } from './queue-status.ts'
import { bindQoderImageTools } from './image-tools.ts'
import type { Context, FiberState } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-web'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { QoderTransportRuntime, transportConfig, type QoderRuntimeConfig } from './transport-runtime.ts'
import { QoderAdapter } from './adapter.ts'
import { QODER_PROVIDER_ID } from './provider.ts'
import { bindQoderSearch } from './search-provider.ts'
import { QoderCatalogLifecycle } from './catalog-lifecycle.ts'
import type { QoderCatalogModel } from '../qoder/catalog.ts'
import { resolveManagedQoderPat } from './credential.ts'
import type { QoderRegion } from '../qoder/region.ts'
import { QoderLlmError } from '../qoder/errors.ts'
import {
  createQoderTransport,
  type QoderTransport,
  type QoderTransportOptions,
} from '../qoder/transport/index.ts'
import { modelsFor, readConfig, type Config as QoderConfig, type LiveConfig } from './config.ts'
import { bindQoderSettings } from './settings.ts'
import { createQoderRpcHandler } from './rpc-handler.ts'
import { registerQoderRpc } from './rpc.ts'
import { QoderBrowserAuthorizationManager, browserAuthorizationKey } from './browser-authorization.ts'
import { qoderCredentialRef } from './credential-contract.ts'

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

export function apply(ctx: Context, input: QoderConfig | LiveConfig = {}): void {
  const leases = new QoderQueueLeases()
  const queueStatus = new QoderQueueStatusStore()
  ctx.effect(() => async () => { queueStatus.dispose(); await leases.dispose() }, 'provider-qoder: queue lifecycle')
  bindQoderQueueLeases(ctx, leases)
  const config = readConfig(input)
  const logger = (ctx as Context & { logger?: QoderLogger }).logger
  const initialRegion = config.region ?? 'global'
  const baseConfig: QoderConfig = {
    ...transportConfig(config),
    modelsByRegion: { ...config.modelsByRegion },
    webSearchMode: config.webSearchMode ?? 'auto',
    imageSearchEnabled: config.imageSearchEnabled ?? true,
    imageGenEnabled: config.imageGenEnabled ?? true,
  }

  let current = (): QoderConfig => baseConfig
  let authorization: QoderBrowserAuthorizationManager
  const createTransport = (value: QoderRuntimeConfig, resolvePat?: () => Promise<string>): QoderTransport => createQoderTransport({
    ...value,
    resolvePat: resolvePat ?? (() => resolveManagedQoderPat(ctx.credentials)),
    resolveCredential: resolvePat ? undefined : signal => authorization.lease(value.region, signal),
    logger,
    attachments: ctx.attachments,
    onQueueUpdate: queueStatus.update,
    captureQueueLeaseOwner: leases.capture,
  })
  const resolveConfig = () => {
    const value = current()
    const transport = transportConfig(value)
    return { ...transport, models: modelsFor(value, transport.region), webSearchMode: value.webSearchMode ?? 'auto' }
  }
  const runtime = new QoderTransportRuntime(current(), createTransport)
  const imageTools = bindQoderImageTools(ctx, {
    logger,
    resolveTransport: () => runtime.transport,
    getImageSearchEnabled: () => current().imageSearchEnabled ?? true,
    getImageGenEnabled: () => current().imageGenEnabled ?? true,
    captureHostRun: sessionId => leases.capture(sessionId)?.run,
  })
  const authorizationTransports = new Map<QoderRegion, NonNullable<QoderTransport['authorization']>>()
  authorization = new QoderBrowserAuthorizationManager({
    credentials: ctx.credentials,
    region: initialRegion,
    transport: region => {
      let transport = authorizationTransports.get(region)
      if (!transport) {
        transport = createQoderTransport({ region, resolvePat: () => Promise.resolve('') }).authorization!
        authorizationTransports.set(region, transport)
      }
      return transport
    },
    changed: () => {
      void catalog.refresh()
    },
  })
  ctx.effect(() => () => authorization.dispose(), 'provider-qoder: browser authorization lifecycle')
  const catalog = new QoderCatalogLifecycle({
    resolveTransport: () => runtime.transport,
    region: () => runtime.config.region,
    configuredModels: region => modelsFor(current(), region),
    onDiscovered: () => registration.replace([providerQoder]),
    onPersistenceError: error => logger?.error?.('[Qoder Settings] Failed to synchronize model catalog', logError(error)),
  })
  ctx.effect(() => () => catalog.dispose(), 'provider-qoder: catalog lifecycle')
  const adapter = new QoderAdapter({
    resolveTransport: () => runtime.transport,
    catalog,
    region: () => runtime.config.region,
    providerId: providerQoder,
    providerName: 'Qoder',
    sessions: ctx.get('sessions'),
    agents: ctx.get('agents'),
  })

  ctx.on('session/disposed', session => adapter.forgetSession(session.id))

  const registration = ctx.llm.registerAdapter([providerQoder], adapter)
  const refreshAuthentication = (): void => {
    const value = resolveConfig()
    runtime.update(value, true)
    authorization.activateRegion(runtime.config.region)
    catalog.clearDiscovered()
    catalog.observeTransport()
    registration.replace([providerQoder])
  }
  ctx.on('credentials/record-updated', key => {
    if (key === browserAuthorizationKey(runtime.config.region)) {
      refreshAuthentication()
      void catalog.refresh()
    }
  })
  ctx.on('credentials/reference-updated', ref => {
    if (ref === qoderCredentialRef) refreshAuthentication()
  })
  const refreshAdapter = (): void => {
    const next = resolveConfig()
    if (runtime.update(next)) authorization.activateRegion(runtime.config.region)
    catalog.observeTransport()
    adapter.replaceModels(next.models)
    registration.replace([providerQoder])
    imageTools.refresh()
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
    const transport = runtime.transport
    if (normalizedPat) {
      const view = await authorization.describe(snapshot.region)
      const managedPat = await resolveManagedQoderPat(ctx.credentials)
      if (view.method !== 'pat' || normalizedPat !== managedPat.trim() || transport !== runtime.transport) {
        return createTransport(transportConfig(snapshot), () => Promise.resolve(normalizedPat)).discoverModels(signal)
      }
    }
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

  const handler = createQoderRpcHandler({
    region: () => resolveConfig().region,
    resolveTransport: () => runtime.transport,
    discoverModels,
    authorization,
    adapter,
    readQueue: sessionId => queueStatus.read(sessionId),
    restoreSession: async sessionId => {
      const sessions = ctx.get('sessions')
      if (!sessions || sessions.get(SessionId(sessionId))) return
      const controller = ctx.get('sessionController')
      if (!controller) return
      const result = await controller.resolveAgent(SessionId(sessionId))
      if ('error' in result) throw result.error
    },
    logger,
  })

  try {
    ctx.effect(() => registerQoderRpc(ctx, handler, listener => adapter.subscribeSessionTiers(listener)), 'provider-qoder: settings RPC routes')
  } catch (error) {
    // The settings RPC is an optional surface: a registration failure must not
    // take the model adapter or the web-search router down with it.
    logger?.error?.('[Qoder RPC] Failed to register the settings RPC routes', logError(error))
  }

  bindQoderSearch(ctx, {
    resolveTransport: () => runtime.transport,
    getWebSearchMode: () => resolveConfig().webSearchMode ?? 'auto',
  })
}
