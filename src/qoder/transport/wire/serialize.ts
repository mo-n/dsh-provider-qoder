/** Build the minimum qodercli request envelope for a validated DSH request. */

import crypto from 'node:crypto'
import { contentHasImage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { QoderLlmError } from '../../errors.ts'
import { translateTools, validateAndTranslateMessages } from './translate.ts'
import type { QoderWireMessage, QoderWireRequest } from './wire-types.ts'
import type { QoderCatalogModel } from '../../catalog.ts'
import type { QoderImageAttachments, QoderImageResolver } from './translate.ts'
import type { CosyCredentials } from './cosy.ts'
import { QoderTurnTracker, type QoderCallKind } from './turn-identity.ts'

function stableHash(prefix: string, ...inputs: string[]): string {
  const hash = crypto.createHash('sha256')
  hash.update(prefix)
  for (const input of inputs) {
    hash.update('\0')
    hash.update(input)
  }
  return hash.digest('hex').slice(0, 16)
}

/**
 * Turn identity shared by every request the process serves.
 *
 * Qoder's Credits panel aggregates consumption per agent run — the
 * `business.id` a request reports — so every step of one turn must carry the
 * same run identity while the next subscriber prompt opens a new one. The
 * tracker owns that boundary; its mode decides which request field carries the
 * turn id.
 */
export const qoderTurnTracker = new QoderTurnTracker({ mode: 'request-set' })

/**
 * Whether this request serves the subscriber's turn or the host's bookkeeping.
 *
 * The host marks an auxiliary call through `GenerateOptions.purpose`, and those
 * calls carry a message list of their own under the same session identity. They
 * must never move the open turn's boundary, or one subscriber prompt would
 * report two consumption records.
 */
function callKind(options: GenerateOptions): QoderCallKind {
  return options.purpose === undefined ? 'conversation' : 'auxiliary'
}

/**
 * Turn id this request continues, or a per-request id when the request cannot
 * be attributed to a conversation because it carries no session identity.
 */
function turnRecordId(options: GenerateOptions, messages: readonly QoderWireMessage[]): string {
  return qoderTurnTracker.resolveTurnRecordId(
    options.sessionId === undefined ? undefined : String(options.sessionId),
    messages,
    callKind(options),
  ) ?? `qoder-request-${crypto.randomUUID()}`
}

/**
 * `request_set_id` and `chat_record_id` for one request.
 *
 * The mode decides which of them carries the turn id; the other mirrors the
 * official client, whose `chat_record_id` equals the request's own `request_id`
 * and whose `request_set_id` stays on the agent run.
 */
function requestIdentity(
  requestId: string,
  options: GenerateOptions,
  messages: readonly QoderWireMessage[],
): { requestSetId: string; chatRecordId: string } {
  const turnId = turnRecordId(options, messages)
  switch (qoderTurnTracker.mode) {
    case 'both':
      return { requestSetId: turnId, chatRecordId: turnId }
    case 'chat-record':
      return { requestSetId: requestId, chatRecordId: turnId }
    case 'request-set':
    default:
      return { requestSetId: turnId, chatRecordId: requestId }
  }
}

/**
 * Reject an unusable request before any credential resolution or provider I/O.
 *
 * Image publication needs credentials, so message translation now runs after
 * authentication. This static pass preserves the guarantee that a request the
 * provider cannot serve never reaches the network.
 */
export function validateQoderRequestShape(
  options: GenerateOptions,
  model?: QoderCatalogModel,
): void {
  if (options.reasoningEffort !== undefined) {
    const effort = String(options.reasoningEffort)
    if (!model?.reasoningEfforts?.some(candidate => candidate.id === effort)) {
      throw new QoderLlmError(
        `Qoder model "${options.model}" does not advertise reasoning effort "${effort}".`,
        'UNSUPPORTED_REASONING_EFFORT',
      )
    }
  }
  if (options.messages.some(message => contentHasImage(message.content)) && model?.supportsImages !== true) {
    throw new QoderLlmError(
      `Qoder model "${options.model}" does not advertise image input.`,
      'UNSUPPORTED_CONTENT',
    )
  }
}

/** Translate a request whose shape has already been validated. */
export function translateQoderMessages(
  options: GenerateOptions,
  attachments?: QoderImageAttachments,
  pipeline?: { uploader?: QoderImageResolver; credentials?: CosyCredentials; preserveThinking?: boolean },
): Promise<QoderWireMessage[]> {
  return validateAndTranslateMessages(
    options.messages,
    options.system,
    attachments,
    options.signal,
    pipeline,
  )
}

export async function validateQoderRequest(
  options: GenerateOptions,
  model?: QoderCatalogModel,
  attachments?: QoderImageAttachments,
): Promise<QoderWireMessage[]> {
  validateQoderRequestShape(options, model)
  return validateAndTranslateMessages(options.messages, options.system, attachments, options.signal)
}

export async function buildQoderRequestBody(
  options: GenerateOptions,
  userId: string,
  translatedMessages?: QoderWireMessage[],
  model?: QoderCatalogModel,
  attachments?: QoderImageAttachments,
): Promise<QoderWireRequest> {
  if (!userId) {
    throw new QoderLlmError('Qoder request identity is missing.', 'AUTH')
  }
  const modelKey = options.model || 'cmodel'
  const messages = translatedMessages ?? await validateQoderRequest(options, model, attachments)
  const modelMaxTokens = model?.maxTokens ?? 32_768
  const maxTokens = Math.min(options.maxTokens ?? modelMaxTokens, modelMaxTokens)
  const isReasoning = options.reasoningEffort !== undefined || (model?.isReasoning ?? false)
  const tools = translateTools(options.tools)
  // Ambiguous defaults stay in discovery metadata, but must not select a request tier.
  const defaultContexts = Object.values(model?.contextOptions ?? {}).filter(option =>
    option.isDefault === true && typeof option.tokenCount === 'number'
    && Number.isFinite(option.tokenCount) && option.tokenCount > 0)
  const contextConfig = model?.contextOptions === undefined || defaultContexts.length !== 1
    ? undefined
    : Object.fromEntries(Object.entries(model.contextOptions).map(([key, value]) => [key, {
      ...value.tokenCount === undefined ? {} : { token_count: value.tokenCount },
      ...value.isDefault === undefined ? {} : { is_default: value.isDefault },
    }]))
  let lastUserText = ''
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === 'user') {
      const content = messages[index].content
      lastUserText = typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.filter(part => part.type === 'text').map(part => part.text).join('')
          : ''
      break
    }
  }

  const stablePart = stableHash('qoder-session', userId, modelKey)
  const sessionId = options.sessionId === undefined
    ? `${stablePart}-${crypto.randomUUID()}`
    : `${stablePart}-${String(options.sessionId)}`
  // One request is one record id, exactly as the official client sends it, and
  // one agent run is one `request_set_id` plus one `business.id`.
  const requestId = crypto.randomUUID()
  // The mode decides which field carries the turn id, mirroring the official
  // client's identity model.
  const identity = requestIdentity(requestId, options, messages)
  const business = qoderTurnTracker.resolveBusinessId(
    options.sessionId === undefined ? undefined : String(options.sessionId),
    messages,
    callKind(options),
  )

  return {
    request_id: requestId,
    request_set_id: identity.requestSetId,
    chat_record_id: identity.chatRecordId,
    session_id: sessionId,
    stream: true,
    chat_task: 'FREE_INPUT',
    is_reply: true,
    is_retry: false,
    source: 1,
    version: '3',
    session_type: 'qodercli',
    agent_id: 'agent_common',
    task_id: 'common',
    code_language: '',
    chat_prompt: '',
    image_urls: null,
    aliyun_user_type: '',
    system: '',
    messages,
    tools,
    parameters: {
      max_tokens: maxTokens,
      ...options.reasoningEffort === undefined
        ? {}
        : { reasoning_effort: String(options.reasoningEffort) },
    },
    chat_context: {
      chatPrompt: '',
      imageUrls: null,
      extra: {
        context: [],
        modelConfig: { key: modelKey, is_reasoning: isReasoning },
        originalContent: lastUserText,
      },
      features: [],
      text: lastUserText,
    },
    model_config: {
      key: modelKey,
      is_reasoning: isReasoning,
      max_output_tokens: maxTokens,
      source: model?.source || 'system',
      ...contextConfig === undefined ? {} : { context_config: contextConfig },
    },
    business: {
      product: 'cli',
      version: '1.0.60',
      type: 'agent',
      stage: 'start',
      // One agent run reports one business id for all of its requests, exactly
      // as the official client does; the service aggregates consumption by it.
      id: business.businessId,
      name: lastUserText.substring(0, 30),
      begin_at: business.beginAt,
    },
  }
}
