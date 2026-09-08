/**
 * DSH-compatible LLM error representation.
 *
 * @module dsh-provider-qoder/errors
 */

import { LlmError, type LlmErrorOptions } from '@deepseek-ai/dsh-llm'

export class QoderLlmError extends LlmError {
  constructor(message: string, code: string = 'UNKNOWN_ERROR', options?: LlmErrorOptions) {
    super(message, code, options)
  }
}

export function qoderHttpError(
  message: string,
  response: { status: number; headers?: Pick<Headers, 'get'> },
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
  return new QoderLlmError(message, code, {
    status,
    ...providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs },
  })
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
