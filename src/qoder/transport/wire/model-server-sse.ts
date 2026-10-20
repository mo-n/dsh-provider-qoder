/** Decode direct model-server SSE frames. */

import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { QoderLlmError, qoderModelServerError } from '../../errors.ts'
import { parseQoderChunks, type QoderSseOptions } from './stream-chunks.ts'
import type { QoderInnerChunk } from './model-types.ts'
import { qoderControlFrameKind } from './control-frames.ts'

function decodeModelServerFrame(rawData: string, options: QoderSseOptions): QoderInnerChunk | undefined {
  const controlKind = qoderControlFrameKind(rawData)
  if (controlKind !== undefined) {
    options.onControlFrame?.(controlKind)
    return undefined
  }
  let value: unknown
  try { value = JSON.parse(rawData) }
  catch { throw new QoderLlmError('Malformed model-server SSE JSON payload.', 'MALFORMED_RESPONSE') }
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
  return parseQoderChunks(stream, decodeModelServerFrame, options)
}
