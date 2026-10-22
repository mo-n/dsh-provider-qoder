/** Decode the legacy COSY model route's wrapped SSE frames. */

import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { QoderLlmError, qoderModelError } from '../../errors.ts'
import { parseQoderChunks, type QoderSseOptions } from './stream-chunks.ts'
import type { QoderInnerChunk, QoderSseEnvelope } from './wire-types.ts'
import { qoderControlFrameKind } from './control-frames.ts'
import { queuedError } from './queue.ts'

export type { QoderSseOptions } from './stream-chunks.ts'

function malformed(message: string): QoderLlmError {
  return new QoderLlmError(message, 'MALFORMED_RESPONSE')
}

function decodeLegacyFrame(rawData: string, options: QoderSseOptions): QoderInnerChunk | '[DONE]' | undefined {
  const outerControlKind = qoderControlFrameKind(rawData)
  if (outerControlKind !== undefined) {
    options.onControlFrame?.(outerControlKind)
    return outerControlKind === 'done' ? '[DONE]' : undefined
  }
  let value: unknown
  try { value = JSON.parse(rawData) }
  catch { throw malformed('Malformed outer SSE JSON payload received from Qoder.') }
  if (value === null || typeof value !== 'object') throw malformed('Malformed outer SSE envelope received from Qoder.')
  const envelope = value as QoderSseEnvelope
  if (envelope.statusCodeValue !== undefined && (typeof envelope.statusCodeValue !== 'number'
    || !Number.isInteger(envelope.statusCodeValue) || envelope.statusCodeValue < 100
    || envelope.statusCodeValue > 599)) {
    throw malformed('Qoder SSE envelope has an invalid status code.')
  }
  if (envelope.statusCodeValue !== undefined && envelope.statusCodeValue !== 200) {
    const queued = options.queueRecovery ? queuedError(envelope.body ?? envelope) : undefined
    if (queued) throw queued
    throw qoderModelError(
      `Qoder service returned upstream error status ${envelope.statusCodeValue}`,
      {
        status: envelope.statusCodeValue,
        cause: envelope.body ?? (envelope as Record<string, unknown>).message,
        source: 'sse', headers: options.headers, httpStatus: options.httpStatus,
      },
    )
  }
  if (envelope.body !== undefined && typeof envelope.body !== 'string') {
    throw malformed('Qoder SSE envelope has an invalid model body.')
  }
  const body = typeof envelope.body === 'string' ? envelope.body.trim() : ''
  if (!body) return undefined
  const innerControlKind = qoderControlFrameKind(body)
  if (innerControlKind !== undefined) {
    if (innerControlKind !== 'done') options.onControlFrame?.(innerControlKind)
    return innerControlKind === 'done' ? '[DONE]' : undefined
  }
  try {
    const inner = JSON.parse(body) as unknown
    if (inner === null || typeof inner !== 'object') throw new Error('not an object')
    return inner as QoderInnerChunk
  } catch {
    throw malformed('Malformed inner model payload received from Qoder.')
  }
}

export function parseQoderSse(stream: ReadableStream<Uint8Array>, options: QoderSseOptions = {}): AsyncGenerator<StreamChunk> {
  return parseQoderChunks(stream, decodeLegacyFrame, options)
}
