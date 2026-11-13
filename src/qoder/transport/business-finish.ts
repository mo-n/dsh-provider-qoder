/** Best-effort agent-run finalization, independent of model queue lease release. */
import { randomUUID } from 'node:crypto'
import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import type { QoderHostRun, QoderRunEnd } from '../turn.ts'
import type { QoderRegion } from '../region.ts'
import { getQoderBusinessFinishUrl } from './endpoints.ts'
import { getMachineId, qoderMachineIdPaths } from './machine-id.ts'
import type { QoderLogger } from './logging.ts'
import { buildAuthHeaders } from './wire/cosy.ts'
import type { QoderCredentials } from './wire/credentials.ts'
import type { QoderBusiness } from './wire/model-types.ts'
import { qoderEncodeBody } from './wire/encoding.ts'

export interface QoderBusinessRequest {
  business: QoderBusiness
  sessionId: string
  modelKey?: string
  credentials: QoderCredentials
}

export interface QoderBusinessFinishDependencies {
  region: QoderRegion
  fetch: typeof fetch
  logger?: QoderLogger
  /** Resolve only the credential lease captured by the dispatched request. */
  resolveCredentials(signal: AbortSignal, rejectedToken?: string): Promise<QoderCredentials>
}

interface BusinessState {
  request: QoderBusinessRequest
  dependencies: QoderBusinessFinishDependencies
  started: boolean
}

// Shared across replaced transports; completed runs have no global strong owner.
const hostedBusinesses = new WeakMap<QoderHostRun, Map<string, BusinessState>>()

/** Called immediately after dispatch, so rejected preparation never opens a business. */
export function retainQoderBusiness(run: QoderHostRun | undefined, request: QoderBusinessRequest, dependencies: QoderBusinessFinishDependencies): void {
  if (!run?.onEnd || !request.business.id) return
  let businesses = hostedBusinesses.get(run)
  if (!businesses) hostedBusinesses.set(run, businesses = new Map())
  const key = JSON.stringify([dependencies.region, request.credentials.userID, request.credentials.organizationId ?? '', request.sessionId, request.business.id])
  const previous = businesses.get(key)
  // ImageGen shares the current business identity. Preserve the original agent
  // metadata instead of letting a tool prompt or later injected context rename it.
  if (previous?.started) return
  const snapshot: QoderBusinessRequest = {
    ...request, business: { ...request.business },
    credentials: { ...request.credentials, organizationTags: request.credentials.organizationTags?.slice() },
  }
  if (previous) {
    previous.request = previous.request.business.type !== 'agent' && request.business.type === 'agent'
      ? snapshot : { ...previous.request, credentials: snapshot.credentials }
    previous.dependencies = dependencies
    return
  }
  const state: BusinessState = { request: snapshot, dependencies, started: false }
  businesses.set(key, state)
  run.onEnd(async end => {
    if (state.started) return
    state.started = true
    await reportQoderBusinessFinish(state.request, end, state.dependencies)
  })
}

/** A forbidden report is recoverable only for explicit subscriber expiry (105). */
function hasBusinessAuthExpiry(text: string): boolean {
  const wrappers = new Set(['403', 'auth_error', 'http_error', 'protocol_error', 'provider_error', 'rate_limit', 'server_error', 'stream_error'])
  const queue: Array<{ value: unknown; depth: number }> = [{ value: JSON.parse(text), depth: 0 }]
  let remaining = 100
  while (queue.length && remaining-- > 0) {
    const { value: raw, depth } = queue.shift()!
    let value = raw
    if (depth > 10) continue
    if (typeof value === 'string' && depth > 0) {
      try { value = JSON.parse(value) } catch { continue }
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
    const object = value as Record<string, unknown>
    const code = typeof object.code === 'number' ? String(object.code)
      : typeof object.code === 'string' ? object.code.trim() : undefined
    if (code && !wrappers.has(code)) return code === '105'
    for (const field of ['error', 'data', 'body', 'message', 'cause', 'details', 'qoderApiError', 'providerError', 'responseBody']) {
      if (object[field] !== undefined) queue.push({ value: object[field], depth: depth + 1 })
    }
  }
  return false
}

async function expiredBusinessCredentials(response: Response, signal: AbortSignal): Promise<boolean> {
  if (!response.body) return false
  const reader = response.body.getReader()
  const cancel = (): void => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  let text = ''
  let bytes = 0
  const decoder = new TextDecoder()
  try {
    for (;;) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      signal.throwIfAborted()
      if (done) break
      bytes += value.byteLength
      if (bytes > 16_384) return false
      text += decoder.decode(value, { stream: true })
    }
    return hasBusinessAuthExpiry(text + decoder.decode())
  } catch {
    signal.throwIfAborted()
    return false
  } finally {
    signal.removeEventListener('abort', cancel)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

/** One ten-second budget covers credentials, dispatch, response cleanup and recovery. */
async function reportQoderBusinessFinish(request: QoderBusinessRequest, end: QoderRunEnd, deps: QoderBusinessFinishDependencies): Promise<void> {
  const modelKey = request.business.model_key ?? request.modelKey
  const controller = new AbortController()
  let interrupt!: () => void
  const interrupted = new Promise<never>((_resolve, reject) => { interrupt = () => reject(new Error('deadline')) })
  const timer = setTimeout(() => { controller.abort(); interrupt() }, 10_000)
  let status: number | undefined
  let reason = 'transport'
  const operation = async (): Promise<void> => {
    const identity = request.credentials
    const mid = identity.machineID || await getMachineId(qoderMachineIdPaths(deps.region))
    const rid = randomUUID()
    const event = {
      event_time: Date.now(), event_type: 'BUSINESS_FINISH', mid,
      aid: '', rid, oid: identity.organizationId ?? '', yid: '', uid: identity.userID,
      event_data: {
        session_id: request.sessionId,
        business: {
          product: request.business.product, version: request.business.version,
          type: request.business.type, id: request.business.id,
          ...modelKey === undefined ? {} : { model_key: modelKey },
          end_at: end.endedAt, stage: end.stage, name: request.business.name,
        },
      },
    }
    const body = qoderEncodeBody(JSON.stringify({ payload: JSON.stringify(event), encodeVersion: '1' }))
    const url = getQoderBusinessFinishUrl(deps.region)
    let credentials = await deps.resolveCredentials(controller.signal)
    for (let attempt = 0; attempt < 2; attempt++) {
      controller.signal.throwIfAborted()
      if (credentials.userID !== identity.userID || (credentials.organizationId ?? '') !== (identity.organizationId ?? '')) {
        reason = 'identity'
        throw new Error('identity')
      }
      const response = await deps.fetch(url, {
        method: 'POST', body, signal: controller.signal,
        headers: {
          ...attributionHeaders(), ...buildAuthHeaders(body, url, { ...credentials, machineID: mid }),
          'Content-Type': 'application/json', Accept: 'application/json',
          'X-Request-Id': rid, 'X-Session-ID': request.sessionId,
        },
      })
      status = response.status
      const expired = status === 403 && attempt === 0
        ? await expiredBusinessCredentials(response, controller.signal) : false
      if (status !== 403 || attempt !== 0) await response.body?.cancel()
      controller.signal.throwIfAborted()
      if ((status === 401 || expired) && attempt === 0) {
        credentials = await deps.resolveCredentials(controller.signal, credentials.authToken)
        continue
      }
      if (!response.ok) { reason = 'http'; throw new Error('http') }
      return
    }
  }
  try {
    await Promise.race([operation(), interrupted])
  } catch {
    deps.logger?.warn?.('[Qoder Business] Finish failed', {
      region: deps.region, reason: controller.signal.aborted ? 'timeout' : reason,
      ...status === undefined ? {} : { status },
    })
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}
