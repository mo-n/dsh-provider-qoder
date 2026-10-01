/**
 * DSH-compatible LLM error representation.
 *
 * @module dsh-provider-qoder/qoder/errors
 */

import {
  CONTEXT_WINDOW_EXCEEDED_CODE, QUOTA_EXCEEDED_CODE,
  isContextWindowExceededError, isQuotaExceededError,
  LlmError, ProviderRequestId, type LlmErrorOptions,
} from '@deepseek-ai/dsh-llm'

export class QoderLlmError extends LlmError {
  upstreamCode?: string
  source?: 'http' | 'sse'
  httpStatus?: number
  constructor(message: string, code: string = 'UNKNOWN_ERROR', options?: LlmErrorOptions) {
    super(message, code, options)
  }
}

const modelBusinessErrors: Record<string, { code: string; message: string }> = {
  '103': { code: 'PROVIDER_ERROR', message: 'Qoder rejected a duplicate model request.' },
  '105': { code: 'AUTH', message: 'Qoder subscriber authentication has expired.' },
  '110': { code: QUOTA_EXCEEDED_CODE, message: 'Qoder daily usage limit has been reached.' },
  '112': { code: QUOTA_EXCEEDED_CODE, message: 'Qoder personal Credits are exhausted.' },
  '114': { code: QUOTA_EXCEEDED_CODE, message: 'Qoder free trial account limit has been reached.' },
  '115': { code: QUOTA_EXCEEDED_CODE, message: 'Qoder free subscriber quota limit has been reached.' },
  '116': { code: QUOTA_EXCEEDED_CODE, message: 'Qoder Teams administrator Credits are exhausted.' },
  '117': { code: QUOTA_EXCEEDED_CODE, message: 'Qoder Teams member Credits are exhausted.' },
  '119': { code: QUOTA_EXCEEDED_CODE, message: 'Qoder Vela model free usage limit has been reached.' },
  '122': { code: QUOTA_EXCEEDED_CODE, message: 'Qoder billing group Credits limit has been reached.' },
  '406': { code: 'PROVIDER_ERROR', message: 'Qoder rejected the request through its content safety policy.' },
  '416': { code: 'INVALID_REQUEST', message: 'Qoder cannot satisfy the requested range.' },
  '430': { code: 'INVALID_REQUEST', message: 'Qoder does not support this request; check client compatibility.' },
  '10605': { code: 'RATE_LIMIT', message: 'Qoder model is queued.' },
  '100400': { code: 'PROVIDER_ERROR', message: 'Qoder custom model service failed.' },
  '100401': { code: 'AUTH', message: 'Qoder custom model authentication failed.' },
  '100403': { code: 'PROVIDER_ERROR', message: 'Qoder custom model is unavailable.' },
}

/** Decode only model rejection diagnostics, with bounded depth, work and JSON size. */
function modelErrorDetails(raw: unknown, status: number): { upstreamCode?: string; detail?: string; textCode?: string; delayMs?: number } {
  let upstreamCode: string | undefined
  let codeDepth = -1
  let detail: string | undefined
  let textCode: string | undefined
  let delayMs: number | undefined
  let remaining = 100
  const seen = new Set<object>()
  function visit(value: unknown, depth: number): void {
    if (depth > 10 || --remaining < 0) return
    if (typeof value === 'string') {
      const text = value.trim()
      if (!text) return
      if (text.length <= 16 * 1024) {
        try { visit(JSON.parse(text), depth + 1); return } catch { /* Plain text diagnostic. */ }
      }
      // Retain classification signals independently of the final display detail.
      const diagnostic = text.slice(0, 16 * 1024)
      if (isContextWindowExceededError(diagnostic)) textCode = CONTEXT_WINDOW_EXCEEDED_CODE
      else if (textCode === undefined && isQuotaExceededError(diagnostic)) textCode = QUOTA_EXCEEDED_CODE
      detail = text.slice(0, 300)
      return
    }
    if (!value || typeof value !== 'object' || Array.isArray(value) || seen.has(value)) return
    seen.add(value)
    const obj = value as Record<string, unknown>
    for (const key of ['code', 'error_code', 'errorCode', 'errCode']) {
      const candidate = obj[key]
      const normalized = typeof candidate === 'number' && Number.isFinite(candidate)
        ? String(candidate) : typeof candidate === 'string' ? candidate.trim() : undefined
      const code = normalized?.slice(0, 100)
      if (!code || code === '0' || (code === String(status) && !Object.hasOwn(modelBusinessErrors, code))) continue
      if (depth >= codeDepth) { upstreamCode = code; codeDepth = depth }
    }
    const seconds = obj.retryAfterSeconds
    if (typeof seconds === 'number' && Number.isFinite(seconds * 1000) && seconds > 0) {
      delayMs = Math.max(delayMs ?? 0, seconds * 1000)
    }
    for (const key of ['message', 'body', 'details', 'error', 'cause', 'data', 'qoderApiError', 'providerError']) {
      visit(obj[key], depth + 1)
    }
  }
  visit(raw, 0)
  return { upstreamCode, detail, textCode, delayMs }
}

/** Model business semantics precede HTTP status; other transport capabilities keep their own protocols. */
export function qoderModelError(
  message: string,
  response: {
    status: number; headers?: Pick<Headers, 'get'>; cause?: unknown
    source: 'http' | 'sse'; httpStatus?: number
  },
): QoderLlmError {
  const details = modelErrorDetails(response.cause, response.status)
  const known = details.upstreamCode === undefined ? undefined
    : Object.hasOwn(modelBusinessErrors, details.upstreamCode) ? modelBusinessErrors[details.upstreamCode] : undefined
  const fallback = qoderHttpError(message, response)
  let code = fallback.code
  let summary = details.detail ? `${message}: ${details.detail}` : message
  if (details.upstreamCode !== undefined) {
    code = known?.code ?? 'PROVIDER_ERROR'
    summary = `${known?.message ?? summary} (Qoder code ${details.upstreamCode}).`
  } else if (details.textCode === CONTEXT_WINDOW_EXCEEDED_CODE) {
    code = CONTEXT_WINDOW_EXCEEDED_CODE
    summary = 'Qoder model context window has been exceeded.'
  } else if (details.textCode === QUOTA_EXCEEDED_CODE) {
    code = QUOTA_EXCEEDED_CODE
    summary = 'Qoder subscriber quota is exhausted.'
  }
  const providerRetryAfterMs = Math.max(fallback.failure.providerRetryAfterMs ?? 0,
    details.delayMs ?? 0) || undefined
  const error = new QoderLlmError(summary, code, {
    status: response.status,
    ...providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs },
    ...fallback.failure.requestId === undefined ? {} : { requestId: fallback.failure.requestId },
    ...response.cause === undefined ? {} : { cause: response.cause },
  })
  error.upstreamCode = details.upstreamCode
  error.source = response.source
  error.httpStatus = response.httpStatus ?? (response.source === 'http' ? response.status : undefined)
  return error
}

export function canRefreshModelCredentials(error: QoderLlmError): boolean {
  return error.source === 'http' && (error.failure.status === 401 || error.failure.status === 403)
    && error.code === 'AUTH' && (error.upstreamCode === undefined || error.upstreamCode === '105')
}

export function qoderHttpError(
  message: string,
  response: { status: number; headers?: Pick<Headers, 'get'>; cause?: unknown },
): QoderLlmError {
  const { status } = response
  const code = status === 401 || status === 403
    ? 'AUTH'
    : status === 408
      ? 'TIMEOUT'
      : status === 429
        ? 'RATE_LIMIT'
        : status >= 500 && status <= 599
          ? 'SERVER'
          : status >= 400 && status <= 499
            ? 'INVALID_REQUEST'
            : 'PROVIDER_ERROR'
  const providerRetryAfterMs = retryAfterMs(response.headers?.get('retry-after') ?? null)
  const requestId = qoderRequestId(response.headers)
  return new QoderLlmError(message, code, {
    status,
    ...providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs },
    ...requestId === undefined ? {} : { requestId },
    ...response.cause === undefined ? {} : { cause: response.cause },
  })
}

export function qoderRequestId(headers?: Pick<Headers, 'get'>): ReturnType<typeof ProviderRequestId> | undefined {
  const value = headers?.get('x-request-id')
    ?? headers?.get('request-id')
    ?? headers?.get('x-amzn-requestid')
  const normalized = value?.trim()
  return normalized ? ProviderRequestId(normalized) : undefined
}

export function retryAfterMs(value: string | null, nowMs = Date.now()): number | undefined {
  const normalized = value?.trim()
  if (!normalized) return undefined
  if (/^\d+$/u.test(normalized)) {
    const delayMs = Number(normalized) * 1000
    return Number.isFinite(delayMs) && delayMs > 0 ? delayMs : undefined
  }
  const retryAt = Date.parse(normalized)
  if (Number.isNaN(retryAt)) return undefined
  const delayMs = retryAt - nowMs
  return delayMs > 0 ? delayMs : undefined
}
