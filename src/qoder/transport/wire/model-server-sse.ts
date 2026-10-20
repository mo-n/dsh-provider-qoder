/** Decode direct model-server SSE frames. */

import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { QoderLlmError, qoderModelServerError } from '../../errors.ts'
import { parseQoderChunks, QoderMalformedJsonFrameError, type QoderMalformedFrameDetails, type QoderSseOptions } from './stream-chunks.ts'
import type { QoderInnerChunk } from './model-types.ts'
import { qoderControlFrameKind } from './control-frames.ts'

function malformedFrameDetails(rawData: string, eventType: string | undefined, error: unknown): QoderMalformedFrameDetails {
  const marker = /^\[[A-Z][A-Z_]{0,63}\]/u.exec(rawData)?.[0]
  const safeEventType = eventType && /^[a-z][\w.-]{0,40}$/iu.test(eventType) ? eventType : undefined
  const message = error instanceof SyntaxError ? error.message : ''
  const offset = /\bposition (\d+)\b/u.exec(message)?.[1]
  const first = rawData.charAt(0)
  const last = rawData.charAt(rawData.length - 1)
  return {
    ...safeEventType === undefined ? {} : { eventType: safeEventType },
    ...marker === undefined ? {} : { marker },
    chars: rawData.length,
    lines: rawData.split('\n').length,
    shape: rawData.startsWith('data:') ? 'nested-data'
      : first === '{' ? 'object' : first === '[' ? 'array' : first === '"' ? 'string' : 'other',
    endsWith: last === '}' ? 'object' : last === ']' ? 'array' : last === '"' ? 'string' : 'other',
    syntax: /end of JSON input|Unterminated string/u.test(message) || offset === String(rawData.length) ? 'truncated'
      : /non-whitespace character after JSON/u.test(message) ? 'trailing-data'
        : /control character/u.test(message) ? 'invalid-control' : 'invalid-json',
    ...offset === undefined ? {} : { syntaxOffset: Number(offset) },
    ...rawData.includes('\r') ? { hasCarriageReturn: true as const } : {},
    ...rawData.includes('\uFFFD') ? { hasReplacementCharacter: true as const } : {},
  }
}

function decodeModelServerFrame(rawData: string, options: QoderSseOptions, eventType?: string): QoderInnerChunk | undefined {
  const controlKind = qoderControlFrameKind(rawData)
  if (controlKind !== undefined) {
    options.onControlFrame?.(controlKind)
    return undefined
  }
  let value: unknown
  try { value = JSON.parse(rawData) }
  catch (error) {
    const details = malformedFrameDetails(rawData, eventType, error)
    options.onMalformedFrame?.(details)
    if (eventType === 'error') {
      throw qoderModelServerError(options.httpStatus ?? 200, {
        error: { message: 'Qoder model-server emitted a non-JSON error SSE event.' },
      }, 'sse', options.headers)
    }
    throw new QoderMalformedJsonFrameError(details.syntax === 'truncated', /^\{\s*"choices"\s*:\s*\[\s*\]\s*[,}]/u.test(rawData))
  }
  if (eventType === 'error') {
    throw qoderModelServerError(options.httpStatus ?? 200, value, 'sse', options.headers)
  }
  if (value === null || typeof value !== 'object') {
    throw new QoderLlmError('Malformed model-server SSE frame.', 'MALFORMED_RESPONSE')
  }
  const payload = value as Record<string, unknown>
  if (payload.error !== undefined) {
    throw qoderModelServerError(options.httpStatus ?? 200, payload, 'sse', options.headers)
  }
  return payload as QoderInnerChunk
}

export function parseModelServerSse(stream: ReadableStream<Uint8Array>, options: QoderSseOptions = {}): AsyncGenerator<StreamChunk> {
  return parseQoderChunks(stream, decodeModelServerFrame, options, {
    ignoreMalformedAfterFinish: true,
    allowIncompleteAuxiliaryFrames: true,
    recoverUnprefixedContinuations: true,
  })
}
