/** Convert decoded Qoder model frames into DSH stream chunks. */

import {
  ToolCallId,
  EMPTY_RESPONSE_CODE,
  type StreamChunk,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm'
import { QoderLlmError } from '../../errors.ts'
import type { QoderInnerChunk } from './model-types.ts'
import type { QoderControlFrameKind } from './control-frames.ts'

const doneMarker = '[DONE]'
const defaultMaxSseBufferChars = 2 * 1024 * 1024

export interface QoderSseOptions {
  queueRecovery?: boolean
  onActivity?: () => void
  onControlFrame?: (kind: QoderControlFrameKind) => void
  onMalformedFrame?: (details: QoderMalformedFrameDetails) => void
  maxBufferChars?: number
  headers?: Pick<Headers, 'get'>
  httpStatus?: number
}

/** Structural diagnostics only; never include raw model text or upstream error bodies. */
export interface QoderMalformedFrameDetails {
  eventType?: string
  marker?: string
  chars: number
  lines: number
  shape: 'object' | 'array' | 'string' | 'nested-data' | 'other'
  endsWith: 'object' | 'array' | 'string' | 'other'
  syntax: 'truncated' | 'trailing-data' | 'invalid-control' | 'invalid-json'
  syntaxOffset?: number
  hasCarriageReturn?: true
  hasReplacementCharacter?: true
  atEof?: boolean
  afterFinish?: boolean
  emptyChoicesPrefix?: boolean
  disposition?: 'skipped-after-finish' | 'skipped-auxiliary' | 'recovered-continuation' | 'rejected'
}

export type QoderFrameDecoder = (rawData: string, options: QoderSseOptions, eventType?: string) => QoderInnerChunk | '[DONE]' | undefined

interface TextualBlockState {
  type: 'text' | 'reasoning'
  index: number
  text: string
}

interface ToolCallState {
  id: string
  name: string
  arguments: string
  emittedArguments: number
  blockIndex?: number
}

type SuccessfulFinishKind = 'stop' | 'tool-calls' | 'max-tokens'

function malformed(message: string): QoderLlmError {
  return new QoderLlmError(message, 'MALFORMED_RESPONSE')
}

/** Distinguish invalid JSON from a valid JSON value with an invalid model shape. */
export class QoderMalformedJsonFrameError extends QoderLlmError {
  readonly incomplete: boolean
  readonly auxiliary: boolean
  constructor(incomplete = false, auxiliary = false) {
    super('Malformed model-server SSE JSON payload.', 'MALFORMED_RESPONSE')
    this.incomplete = incomplete
    this.auxiliary = auxiliary
  }
}

function tokenUsage(innerChunk: QoderInnerChunk): TokenUsage | undefined {
  if (!innerChunk.usage) return undefined
  const usage = innerChunk.usage
  const promptTokens = usage.prompt_tokens ?? 0
  const cacheReadTokens = usage.prompt_tokens_details?.cached_tokens ?? 0
  const cacheWriteTokens = usage.prompt_tokens_details?.cache_write_tokens ?? 0
  const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens
  return {
    inputTokens: Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens),
    outputTokens: usage.completion_tokens ?? 0,
    ...cacheReadTokens > 0 ? { cacheReadTokens } : {},
    ...cacheWriteTokens > 0 ? { cacheWriteTokens } : {},
    ...reasoningTokens === undefined ? {} : { reasoningTokens },
  }
}

function finishKind(value: string | null | undefined): SuccessfulFinishKind | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (value === 'stop') return 'stop'
  if (value === 'length') return 'max-tokens'
  // Qoder CLI accepts this legacy OpenAI alias alongside "tool_calls".
  if (value === 'tool_calls' || value === 'toolUse' || value === 'function_call') return 'tool-calls'
  if (value === 'content_filter') {
    throw new QoderLlmError('Qoder blocked the response through its content filter.', 'PROVIDER_ERROR')
  }
  throw malformed(`Qoder returned unknown finish reason "${value}".`)
}

type QoderInnerDelta = NonNullable<QoderInnerChunk['choices']>[number]['delta']

/** Whether a choice delta streams content, reasoning, or tool-call data. Control-only frames do not. */
function carriesStreamDelta(delta: QoderInnerDelta): boolean {
  if (delta == null) return false
  if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) return true
  if (typeof delta.content === 'string' && delta.content) return true
  if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) return true
  return false
}

export async function* parseQoderChunks(
  stream: ReadableStream<Uint8Array>,
  decodeFrame: QoderFrameDecoder,
  options: QoderSseOptions = {},
  behavior: {
    ignoreMalformedAfterFinish?: boolean
    allowIncompleteAuxiliaryFrames?: boolean
    recoverUnprefixedContinuations?: boolean
  } = {},
): AsyncGenerator<StreamChunk> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const toolCalls = new Map<number, ToolCallState>()
  let buffer = ''
  let eventData: string[] = []
  let continuedEventData: string[] = []
  let eventDataChars = 0
  let eventType: string | undefined
  let sourceEnded = false
  let sawDone = false
  let nextBlockIndex = 0
  let activeTextual: TextualBlockState | undefined
  let pendingUsage: TokenUsage | undefined
  let terminalKind: SuccessfulFinishKind = 'stop'
  let sawFinishReason = false
  let sawContent = false
  const maxBufferChars = options.maxBufferChars ?? defaultMaxSseBufferChars

  const closeTextual = (): StreamChunk[] => {
    if (activeTextual === undefined) return []
    const state = activeTextual
    activeTextual = undefined
    return [{
      type: 'block-end',
      index: state.index,
      block: state.type === 'text'
        ? { type: 'text', text: state.text }
        : { type: 'reasoning', text: state.text },
    }]
  }

  const appendSegment = (segment: Pick<TextualBlockState, 'type' | 'text'>): StreamChunk[] => {
    if (!segment.text) return []
    const chunks: StreamChunk[] = []
    sawContent = true
    if (activeTextual?.type !== segment.type) {
      chunks.push(...closeTextual())
      activeTextual = { type: segment.type, index: nextBlockIndex++, text: '' }
      chunks.push({ type: 'block-start', index: activeTextual.index, blockType: segment.type })
    }
    activeTextual.text += segment.text
    chunks.push(segment.type === 'text'
      ? { type: 'text-delta', index: activeTextual.index, text: segment.text }
      : { type: 'reasoning-delta', index: activeTextual.index, text: segment.text })
    return chunks
  }

  const openToolCall = (state: ToolCallState): StreamChunk[] => {
    if (!state.id || state.blockIndex !== undefined) return []
    const chunks = closeTextual()
    state.blockIndex = nextBlockIndex++
    sawContent = true
    chunks.push({ type: 'block-start', index: state.blockIndex, blockType: 'tool-call' })
    const argumentsDelta = state.arguments.slice(state.emittedArguments)
    state.emittedArguments = state.arguments.length
    chunks.push({
      type: 'tool-call-delta',
      index: state.blockIndex,
      id: ToolCallId(state.id),
      ...state.name ? { name: state.name } : {},
      argumentsDelta,
    })
    return chunks
  }

  try {
    while (!sourceEnded && !sawDone) {
      const { done, value } = await reader.read()
      if (done) {
        sourceEnded = true
        buffer += decoder.decode()
        if (buffer.length > 0 && !buffer.endsWith('\n')) buffer += '\n'
        // Dispatch the final event even if the provider omits its blank terminator.
        buffer += '\n'
      } else {
        options.onActivity?.()
        buffer += decoder.decode(value, { stream: true })
        // A read may contain many complete events. Bound each event below, not the read.
      }

      while (!sawDone) {
        const lineEnd = buffer.indexOf('\n')
        if (lineEnd === -1) {
          // Use the same payload accounting before and after the newline arrives.
          const pending = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer
          const pendingChars = pending.startsWith('data:')
            ? eventDataChars + pending.slice(pending.startsWith('data: ') ? 6 : 5).length + 1
            : pending.length
          if (pendingChars > maxBufferChars) throw malformed('Qoder SSE frame exceeded its size limit.')
          break
        }
        let line = buffer.substring(0, lineEnd)
        buffer = buffer.substring(lineEnd + 1)
        if (line.endsWith('\r')) line = line.slice(0, -1)
        if (!line.startsWith('data:') && line.length > maxBufferChars) throw malformed('Qoder SSE frame exceeded its size limit.')
        if (line.startsWith('event:')) {
          eventType = line.substring(6).trim()
          continue
        }
        if (line.startsWith('data:')) {
          const value = line.substring(5)
          const data = value.startsWith(' ') ? value.substring(1) : value
          eventData.push(data)
          if (behavior.recoverUnprefixedContinuations) continuedEventData.push(data)
          eventDataChars += data.length + 1
          if (eventDataChars > maxBufferChars) throw malformed('Qoder SSE frame exceeded its size limit.')
          continue
        }
        if (line !== '') {
          // Preserve possible unprefixed JSON continuations, excluding SSE fields and comments.
          // These bytes are used only if the standard data payload fails JSON decoding.
          // A split immediately before a JSON property separator can resemble an SSE comment
          // (e.g. `"created"\n:1792486219,...`). Retain only colon lines starting a JSON value;
          // the complete reconstructed event must still pass the normal decoder.
          const jsonPropertyContinuation = /^:\s*(?:-?\d|true\b|false\b|null\b|["{\[\\])/u.test(line)
          if (behavior.recoverUnprefixedContinuations && continuedEventData.length > 0
            && (!line.startsWith(':') || jsonPropertyContinuation) && !/^[a-zA-Z][\w-]*(?::|$)/u.test(line)) {
            const index = continuedEventData.length - 1
            continuedEventData[index] += line
            eventDataChars += line.length
            if (eventDataChars > maxBufferChars) throw malformed('Qoder SSE frame exceeded its size limit.')
          }
          continue
        }

        const rawData = eventData.join('\n').trim()
        const continuedData = continuedEventData.join('\n').trim()
        const frameEventType = eventType
        eventData = []
        continuedEventData = []
        eventDataChars = 0
        eventType = undefined
        if (!rawData) continue
        if (rawData === doneMarker) {
          options.onControlFrame?.('done')
          sawDone = true
          break
        }

        let innerChunk: QoderInnerChunk | '[DONE]' | undefined
        let malformedDetails: QoderMalformedFrameDetails | undefined
        try {
          const frameOptions: QoderSseOptions = {
            ...options,
            onMalformedFrame: details => {
              malformedDetails = {
                ...details,
                atEof: sourceEnded,
                afterFinish: sawFinishReason,
              }
            },
          }
          try {
            innerChunk = decodeFrame(rawData, frameOptions, frameEventType)
          } catch (error) {
            if (!(error instanceof QoderMalformedJsonFrameError) || !continuedData || continuedData === rawData) throw error
            const originalDetails = malformedDetails
            innerChunk = decodeFrame(continuedData, frameOptions, frameEventType)
            if (originalDetails) options.onMalformedFrame?.({ ...originalDetails, disposition: 'recovered-continuation' })
          }
        } catch (error) {
          // qodercli 1.1.73 ignores non-JSON trailers after a model finish reason.
          // A malformed frame before that point is still a protocol failure.
          const malformedJson = error instanceof QoderMalformedJsonFrameError ? error : undefined
          const skippedAfterFinish = behavior.ignoreMalformedAfterFinish && sawFinishReason
            && frameEventType !== 'error' && malformedJson !== undefined
          const skippedAuxiliary = !sourceEnded && behavior.allowIncompleteAuxiliaryFrames
            && malformedJson?.incomplete && malformedJson.auxiliary && frameEventType !== 'error'
          if (malformedDetails !== undefined) options.onMalformedFrame?.({
            ...malformedDetails,
            emptyChoicesPrefix: malformedJson?.auxiliary ?? false,
            disposition: skippedAfterFinish ? 'skipped-after-finish'
              : skippedAuxiliary ? 'skipped-auxiliary' : 'rejected',
          })
          if (skippedAfterFinish) continue
          if (sourceEnded && error instanceof QoderMalformedJsonFrameError && error.incomplete) {
            throw new QoderLlmError('Qoder SSE connection ended with an incomplete JSON event before model completion.', 'TRANSPORT')
          }
          // An empty-choices metadata frame carries no model delta. Keep reading for
          // independent completion evidence; the EOF check still rejects an unfinished turn.
          if (skippedAuxiliary) continue
          throw error
        }
        if (innerChunk === undefined) continue
        if (innerChunk === doneMarker) {
          options.onControlFrame?.('done')
          sawDone = true
          break
        }
        pendingUsage = tokenUsage(innerChunk) ?? pendingUsage

        for (const choice of innerChunk.choices ?? []) {
          const kind = finishKind(choice.finish_reason)
          if (kind !== undefined) {
            terminalKind = kind
            sawFinishReason = true
          } else if (carriesStreamDelta(choice.delta)) {
            // A finish reason is terminal only while nothing streams after it. A later content or
            // tool delta means the turn kept going, so the sentinel is required again at EOF.
            sawFinishReason = false
          }
          const delta = choice.delta
          if (!delta) continue

          if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
            // Qoder already identifies reasoning by field; preserve its text verbatim.
            for (const chunk of appendSegment({ type: 'reasoning', text: delta.reasoning_content })) yield chunk
          }
          if (typeof delta.content === 'string' && delta.content) {
            // Thinking tags in visible content are literal text, including code examples.
            for (const chunk of appendSegment({ type: 'text', text: delta.content })) yield chunk
          }

          if (delta.tool_calls !== undefined) {
            if (!Array.isArray(delta.tool_calls)) throw malformed('Qoder tool-call delta is not an array.')
            for (const rawCall of delta.tool_calls) {
              if (typeof rawCall !== 'object' || rawCall === null || Array.isArray(rawCall)) {
                throw malformed('Qoder tool-call delta is not an object.')
              }
              const upstreamIndex = rawCall.index ?? 0
              if (!Number.isInteger(upstreamIndex) || upstreamIndex < 0) {
                throw malformed('Qoder tool-call delta has an invalid index.')
              }
              let state = toolCalls.get(upstreamIndex)
              if (state === undefined) {
                state = { id: '', name: '', arguments: '', emittedArguments: 0 }
                toolCalls.set(upstreamIndex, state)
              }
              if (rawCall.id !== undefined) {
                if (rawCall.id === '' || rawCall.id === null) {
                  // Upstream models and gateways often emit empty or null IDs in parameter deltas.
                  // Tolerate and ignore when an ID is already established, or wait for later chunks.
                } else if (typeof rawCall.id !== 'string') {
                  throw malformed('Qoder tool call has an invalid id.')
                } else {
                  if (state.id && state.id !== rawCall.id) throw malformed('Qoder changed a streamed tool-call id.')
                  state.id = rawCall.id
                }
              }
              let hasNewName = false
              if (rawCall.function?.name !== undefined) {
                const name = rawCall.function.name
                if (name === '' || name === null) {
                  // Upstream models and gateways often emit empty or null names in parameter deltas.
                  // Tolerate and ignore when a name is already established, or wait for later chunks.
                } else if (typeof name !== 'string') {
                  throw malformed('Qoder tool call has an invalid name.')
                } else {
                  if (state.name && state.name !== name) throw malformed('Qoder changed a streamed tool-call name.')
                  if (state.name !== name) {
                    state.name = name
                    hasNewName = true
                  }
                }
              }
              if (rawCall.function?.arguments !== undefined) {
                if (typeof rawCall.function.arguments !== 'string') {
                  throw malformed('Qoder tool-call arguments delta is not a string.')
                }
                state.arguments += rawCall.function.arguments
              }

              const wasOpen = state.blockIndex !== undefined
              for (const chunk of openToolCall(state)) yield chunk
              if (wasOpen && state.blockIndex !== undefined && state.emittedArguments < state.arguments.length) {
                const argumentsDelta = state.arguments.slice(state.emittedArguments)
                state.emittedArguments = state.arguments.length
                yield {
                  type: 'tool-call-delta',
                  index: state.blockIndex,
                  id: ToolCallId(state.id),
                  ...state.name ? { name: state.name } : {},
                  argumentsDelta,
                }
              } else if (wasOpen && state.blockIndex !== undefined && hasNewName) {
                yield {
                  type: 'tool-call-delta',
                  index: state.blockIndex,
                  id: ToolCallId(state.id),
                  name: state.name,
                  argumentsDelta: '',
                }
              }
            }
          }
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }

  // Qoder does not always close the SSE body with a [DONE] sentinel. A terminal finish reason that
  // nothing streamed past proves the turn declared completion, so only a stream without one is a
  // truncation.
  if (!sawDone && !sawFinishReason) throw new QoderLlmError('SSE stream ended prematurely without [DONE].', 'TRANSPORT')

  for (const chunk of closeTextual()) yield chunk

  for (const [, state] of [...toolCalls.entries()].sort(([left], [right]) => left - right)) {
    if (!state.id || !state.name) throw malformed('Qoder completed an unidentifiable tool call.')
    const normalizedArguments = state.arguments.trim() ? state.arguments : '{}'
    try {
      JSON.parse(normalizedArguments)
    } catch {
      throw malformed(`Qoder completed tool call "${state.name}" with malformed JSON arguments.`)
    }
    for (const chunk of openToolCall(state)) yield chunk
    if (state.blockIndex === undefined) throw malformed('Qoder failed to open a completed tool call.')
    if (state.emittedArguments === 0 && normalizedArguments === '{}') {
      yield {
        type: 'tool-call-delta',
        index: state.blockIndex,
        id: ToolCallId(state.id),
        name: state.name,
        argumentsDelta: '{}',
      }
    }
    yield {
      type: 'block-end',
      index: state.blockIndex,
      block: {
        type: 'tool-call',
        id: ToolCallId(state.id),
        name: state.name,
        arguments: normalizedArguments,
      },
    }
  }

  if (pendingUsage) yield { type: 'usage', usage: pendingUsage }
  if (!sawContent) {
    yield {
      type: 'finish',
      reason: {
        kind: 'error',
        failure: { message: 'Model returned a completed response with no content.', code: EMPTY_RESPONSE_CODE },
      },
    }
    return
  }
  yield { type: 'finish', reason: { kind: toolCalls.size > 0 ? 'tool-calls' : terminalKind } }
}
