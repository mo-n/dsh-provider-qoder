/** Decode queue fields from the provider's nested JSON envelopes, never from prose. */
import { QoderModelQueuedError } from '../../errors.ts'
import type { QoderQueueStatus } from '../../queue.ts'

function records(value: unknown): Record<string, unknown>[] {
  const pending = [value]
  const seen = new Set<object>()
  const result: Record<string, unknown>[] = []
  // Bound traversal even for deeply nested stringified or adversarial responses.
  for (let count = 0; pending.length && count < 64; count++) {
    let next = pending.shift()
    if (typeof next === 'string') {
      if (next.length > 65_536) continue
      try { next = JSON.parse(next) } catch { continue }
    }
    if (!next || typeof next !== 'object' || Array.isArray(next) || seen.has(next)) continue
    seen.add(next)
    const record = next as Record<string, unknown>
    result.push(record)
    for (const key of ['error', 'data', 'result', 'message', 'body', 'cause', 'queue', 'details', 'qoderApiError', 'providerError']) {
      if (record[key] !== undefined) pending.push(record[key])
    }
  }
  return result
}

function boolean(value: unknown): boolean | undefined {
  return value === true || value === 'true' ? true : value === false || value === 'false' ? false : undefined
}

function number(value: unknown): number | undefined {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= Number.MAX_SAFE_INTEGER / 1000 ? parsed : undefined
}

function status(record: Record<string, unknown>): QoderQueueStatus {
  const result: QoderQueueStatus = {}
  for (const key of ['isQueued', 'serviceAvailable'] as const) {
    const value = boolean(record[key])
    if (value !== undefined) result[key] = value
  }
  for (const key of ['queueCount', 'waitTime', 'retryAfterSeconds'] as const) {
    const value = number(record[key])
    if (value !== undefined) result[key] = value
  }
  for (const key of ['modelKey', 'queueType'] as const) {
    const value = record[key]
    if (typeof value === 'string' && value.trim() && value.length <= 256) result[key] = value.trim()
  }
  return result
}

export function parseQueueStatus(value: unknown): QoderQueueStatus | undefined {
  for (const record of records(value)) {
    const parsed = status(record)
    if (parsed.isQueued !== undefined || parsed.serviceAvailable !== undefined) return parsed
  }
  return undefined
}

export function queuedError(value: unknown): QoderModelQueuedError | undefined {
  const candidates = records(value)
  if (!candidates.some(record => String(record.code) === '10605' || boolean(record.isQueued) === true)) return undefined
  const queue = candidates.map(status).find(candidate => candidate.isQueued === true || candidate.waitTime !== undefined)
    ?? candidates.map(status).find(candidate => Object.keys(candidate).length > 0)
    ?? {}
  return new QoderModelQueuedError(queue)
}
