/** Qoder settings RPC dispatch, validation, and public failure classification. */
import type { QoderCatalogModel } from '../qoder/catalog.ts'
import type { QoderRegion } from '../qoder/region.ts'
import type { QoderTransport, QoderTransportOptions } from '../qoder/transport/index.ts'
import { QoderLlmError } from '../qoder/errors.ts'
import { redactLogValue } from '../qoder/transport/logging.ts'
import type { QoderCatalogLifecycle } from './catalog-lifecycle.ts'
import type { QoderAdapter } from './adapter.ts'
import type { QoderBrowserAuthorizationManager } from './browser-authorization.ts'
import type { QoderQueueStatusStore } from './queue-status.ts'
import { QoderRequestError } from './request-error.ts'
import { isQoderRpcEndpoint, type QoderCatalogEdit, type QoderCatalogToggle, type QoderRpcErrorCode, type QoderJsonRpcEndpoint, type QoderRpcOutput } from './rpc-channel.ts'
import type { QoderRpcHandler } from './rpc.ts'

type QoderLogger = NonNullable<QoderTransportOptions['logger']>

interface QoderRpcHandlerOptions {
  /** Resolve live configuration and transport on each request. */
  region(): QoderRegion
  resolveTransport(): Pick<QoderTransport, 'readAccount'>
  discoverModels(signal?: AbortSignal): Promise<readonly QoderCatalogModel[]>
  catalog?: Pick<QoderCatalogLifecycle, 'refreshCatalog' | 'editCatalog' | 'status'>
  readModels(): { region: QoderRegion; models: readonly QoderCatalogModel[] }
  authorization: Pick<QoderBrowserAuthorizationManager, 'begin' | 'cancel' | 'select' | 'describe'>
  adapter: Pick<QoderAdapter, 'setSessionTier' | 'readSessionTier'>
  readQueue: QoderQueueStatusStore['read']
  readModelRefusal?(sessionId: string): string | undefined
  dismissModelRefusal?(sessionId: string, id: string): void
  /** Join host restoration when needed; the host owns session publication. */
  restoreSession(sessionId: string): Promise<void>
  settingsNamespace?(): string
  logger?: QoderLogger
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

function validSessionId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 256
}

async function executeRpc<E extends QoderJsonRpcEndpoint>(
  _endpoint: E,
  operation: string,
  task: () => Promise<QoderRpcOutput<E>>,
  signal: AbortSignal,
  logger?: QoderLogger,
): Promise<QoderHostRpcResult<QoderRpcOutput<E>>> {
  try {
    return { ok: true, value: await task() }
  } catch (error) {
    if (signal.aborted || (error instanceof QoderLlmError && error.code === 'ABORTED')) {
      logger?.debug?.(`[Qoder RPC] ${operation} was aborted`)
      return publicError('ABORTED', 'Request aborted')
    }
    let code: QoderRpcErrorCode = 'INTERNAL'
    if (error instanceof QoderLlmError) {
      if (error instanceof QoderRequestError) {
        code = 'INVALID_REQUEST'
      } else if (error.code === 'CATALOG_REFRESHING') {
        return publicError('CATALOG_REFRESHING', error.message)
      } else if (error.code === 'CATALOG_SAVE_FAILED') {
        code = 'CATALOG_SAVE_FAILED'
      } else if (error.code === 'INTERNAL') {
        code = 'INTERNAL'
      } else if (error.code === 'MISSING_CREDENTIAL' || error.code === 'NO_CREDENTIALS') {
        code = 'NO_CREDENTIALS'
      } else if (error.code === 'AUTH') {
        code = 'UNAUTHENTICATED'
      } else if (error.code === 'TIMEOUT') {
        code = 'TIMEOUT'
      } else {
        code = 'UPSTREAM_ERROR'
      }
    }
    logger?.error?.(`[Qoder RPC] Failed to ${operation}`, redactLogValue(error))
    return publicError(code, error instanceof Error ? error.message : `Failed to ${operation}`)
  }
}

function catalogEdit(value: unknown): QoderCatalogEdit | undefined {
  if (typeof value !== 'object' || value === null) return
  const { action, id, enabled, tierKey, toggles } = value as Record<string, unknown>
  if (action === 'toggleBatch') {
    if (!Array.isArray(toggles) || !toggles.length) return
    const parsed: QoderCatalogToggle[] = []
    const ids = new Set<string>()
    for (const toggle of toggles) {
      if (typeof toggle !== 'object' || toggle === null) return
      const { id, enabled } = toggle as Record<string, unknown>
      if (typeof id !== 'string' || !id.trim() || typeof enabled !== 'boolean' || ids.has(id)) return
      ids.add(id)
      parsed.push({ id, enabled })
    }
    return { action, toggles: parsed }
  }
  if (typeof id !== 'string' || !id.trim()) return
  if (action === 'delete') return { action, id }
  if (action === 'toggle' && typeof enabled === 'boolean') return { action, id, enabled }
  if (action === 'selectTier' && typeof tierKey === 'string' && tierKey.trim()) return { action, id, tierKey }
}

/** Create a handler without registering routes or taking ownership of dependencies. */
export function createQoderRpcHandler(options: QoderRpcHandlerOptions): QoderRpcHandler {
  const { resolveTransport, discoverModels, authorization, adapter, readQueue, restoreSession, logger } = options
  const settingsNamespace = options.settingsNamespace ?? (() => 'provider-qoder')
  return async (endpoint, payload, signal) => {
    if (!isQoderRpcEndpoint(endpoint)) return publicError('UNKNOWN_ENDPOINT', `Unknown endpoint: ${endpoint}`)
    if (signal.aborted) return publicError('ABORTED', 'Request aborted')
    if (endpoint === 'sessionTierEvents' || endpoint === 'catalogEvents') return publicError('UNKNOWN_ENDPOINT', 'This endpoint requires the event stream handler')
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return publicError('INVALID_REQUEST', 'An object payload is required')
    const data = payload as Record<string, unknown>

    if (endpoint === 'bootstrap') {
      const namespace = settingsNamespace()
      if (!namespace.trim()) return publicError('INTERNAL', 'Qoder settings namespace is unavailable')
      return { ok: true, value: { settingsNamespace: namespace } }
    }

    if (endpoint === 'authorization' || endpoint === 'beginLogin' || endpoint === 'cancelLogin' || endpoint === 'selectAuthorization') {
      const region = data?.region
      if ((region !== 'global' && region !== 'china') || region !== options.region()) {
        return publicError('INVALID_REQUEST', 'The active Qoder service region is required')
      }
      const method = data.method
      if (endpoint === 'selectAuthorization' && method !== 'pat' && method !== 'browser' && method !== 'none') return publicError('INVALID_REQUEST', 'Invalid authorization method.')
      return executeRpc(endpoint, 'manage Qoder authorization', async () => {
        if (endpoint === 'beginLogin') return authorization.begin(region)
        if (endpoint === 'cancelLogin') { await authorization.cancel(region); return authorization.describe(region) }
        if (endpoint === 'selectAuthorization') {
          return authorization.select(region, method as 'pat' | 'browser' | 'none')
        }
        return authorization.describe(region)
      }, signal, logger)
    }

    if (endpoint === 'queue' || endpoint === 'conversationStatus') {
      const sessionId = data.sessionId
      if (!validSessionId(sessionId)) return publicError('INVALID_REQUEST', 'A valid sessionId is required')
      if (endpoint === 'queue') return { ok: true, value: readQueue(sessionId) }
      const dismissedRefusalId = data.dismissedRefusalId
      if (dismissedRefusalId !== undefined) {
        if (typeof dismissedRefusalId !== 'string' || !dismissedRefusalId || dismissedRefusalId.length > 64) {
          return publicError('INVALID_REQUEST', 'Invalid dismissedRefusalId')
        }
        options.dismissModelRefusal?.(sessionId, dismissedRefusalId)
      }
      const refusalId = options.readModelRefusal?.(sessionId)
      return { ok: true, value: { queue: readQueue(sessionId), refused: refusalId !== undefined,
        ...refusalId === undefined ? {} : { refusalId } } }
    }

    if (endpoint === 'models') {
      return await executeRpc(endpoint, 'discover Qoder models', () => discoverModels(signal), signal, logger)
    }

    if (endpoint === 'refreshCatalog' || endpoint === 'editCatalog' || endpoint === 'catalogStatus') {
      const { region } = data
      const catalog = options.catalog
      if (!catalog) return publicError('INTERNAL', 'Qoder catalog settings are unavailable.')
      if (region !== 'global' && region !== 'china') return publicError('INVALID_REQUEST', 'A valid Qoder service region is required.')
      if (endpoint === 'catalogStatus') return { ok: true, value: catalog.status(region) }
      if (endpoint === 'refreshCatalog') {
        return executeRpc(endpoint, 'refresh the Qoder model catalog', () => catalog.refreshCatalog(region, signal), signal, logger)
      }
      const edit = catalogEdit(data.edit)
      if (!edit) return publicError('INVALID_REQUEST', 'Invalid Qoder catalog edit.')
      return executeRpc(endpoint, 'edit the Qoder model catalog', () => catalog.editCatalog(region, edit), signal, logger)
    }

    if (endpoint === 'modelRates') {
      return await executeRpc(endpoint, 'read Qoder model rates', async () => {
        const { region, models } = options.readModels()
        const rates = models.map(({ id, priceFactor, originalPriceFactor, isFree }) => ({
          id, priceFactor, originalPriceFactor, isFree,
        }))
        return { region, rates }
      }, signal, logger)
    }

    if (endpoint === 'sessionTier' || endpoint === 'readSessionTier') {
      if (validSessionId(data.sessionId) && typeof data.modelId === 'string' && data.modelId.trim() && (endpoint === 'readSessionTier' || (typeof data.tierKey === 'string' && data.tierKey.trim())) && (data.region === 'global' || data.region === 'china')) {
        const { sessionId, modelId, tierKey, region } = data
        return await executeRpc(endpoint, endpoint === 'sessionTier' ? 'select session context tier' : 'read session context tier', async () => {
          if (!sessionId.trim() || region !== options.region()) {
            throw new QoderRequestError('The active Qoder service region is required.')
          }
          try {
            await restoreSession(sessionId)
          } catch (error) {
            throw new Error('Failed to restore the host session.', { cause: error })
          }
          signal.throwIfAborted()
          if (endpoint === 'sessionTier') adapter.setSessionTier(sessionId, modelId, tierKey as string, region)
          return adapter.readSessionTier({ sessionId, modelId, region })
        }, signal, logger)
      }
      return publicError('INVALID_REQUEST', 'Invalid session Context Tier payload')
    }

    if ('force' in data && typeof data.force !== 'boolean') return publicError('INVALID_REQUEST', 'force must be a boolean')
    const force = data.force === true
    logger?.debug?.('[Qoder RPC] Reading subscriber account', { force })
    const outcome = await executeRpc(
      endpoint,
      'load Qoder account',
      () => resolveTransport().readAccount({ force, signal }),
      signal,
      logger,
    )
    if (outcome.ok) logger?.debug?.('[Qoder RPC] Subscriber account resolved')
    return outcome
  }
}
