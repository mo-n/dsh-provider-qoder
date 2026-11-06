/** Shared model request preparation, before selecting a wire protocol. */

import type { QoderHostRun } from '../../turn.ts'

import crypto from 'node:crypto'
import { type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { selectedContextTier, type QoderCatalogModel } from '../../catalog.ts'
import { QoderLlmError } from '../../errors.ts'
import { qoderIdeVersion } from './client-identity.ts'
import { translateTools, userMessagesBeforeImageTrimming, validateAndTranslateMessages, validateMessageShapes } from './translate.ts'
import type { QoderImageAttachments, QoderTranslationOptions } from './translate.ts'
import { QoderTurnTracker, wireMessageText, type QoderCallKind } from './turn-identity.ts'
import type { QoderBusiness, QoderContextConfig, QoderWireMessage, QoderWireTool } from './model-types.ts'

export interface PreparedQoderRequest {
  requestId: string
  requestSetId: string
  chatRecordId: string
  sessionId: string
  taskId: string
  modelKey: string
  modelSource: string
  messages: QoderWireMessage[]
  tools: QoderWireTool[]
  maxTokens: number
  contextLength?: number
  reasoningEffort?: string
  isReasoning: boolean
  contextConfig?: QoderContextConfig
  lastUserText: string
  business: QoderBusiness
}

/** One tracker preserves agent-run identity across both model protocols. */
export const qoderTurnTracker = new QoderTurnTracker()

/**
 * Process-local mapping from a DSH conversation to Qoder's UUID session id.
 *
 * The upstream wire value must be a UUID rather than a provider-readable hash,
 * while model and image capabilities still need to resolve the same DSH session
 * to the same value. A restarted DSH process starts a new upstream session.
 */
const qoderSessionIds = new Map<string, string>()

/** Shared subscriber-and-region-scoped conversation identity for model and image requests. */
export function qoderSessionId(userId: string, sessionId?: string, identityScope = ''): string {
  if (sessionId === undefined || sessionId.length === 0) return crypto.randomUUID()
  const key = JSON.stringify([identityScope, userId, sessionId])
  const existing = qoderSessionIds.get(key)
  if (existing !== undefined) return existing
  const created = crypto.randomUUID()
  qoderSessionIds.set(key, created)
  return created
}


function callKind(options: GenerateOptions): QoderCallKind {
  // Newer DSH hosts provide review attribution; older pinned host types do not
  // yet include this purpose. Match only the explicit runtime value.
  if (String(options.purpose) === 'auto-review') return 'auto-review'
  return options.purpose === undefined ? 'conversation' : 'auxiliary'
}

export function validateQoderRequestShape(options: GenerateOptions, model?: QoderCatalogModel, attachments?: QoderImageAttachments): void {
  const hasImages = validateMessageShapes(options.messages, attachments)
  if (options.reasoningEffort !== undefined) {
    const effort = String(options.reasoningEffort)
    if (!model?.reasoningEfforts?.some(candidate => candidate.id === effort)) {
      throw new QoderLlmError(
        `Qoder model "${options.model}" does not advertise reasoning effort "${effort}".`,
        'UNSUPPORTED_REASONING_EFFORT',
      )
    }
  }
  if (hasImages && model?.supportsImages !== true) {
    throw new QoderLlmError(`Qoder model "${options.model}" does not advertise image input.`, 'UNSUPPORTED_CONTENT')
  }
}

export function translateQoderMessages(
  options: GenerateOptions,
  attachments?: QoderImageAttachments,
  pipeline?: QoderTranslationOptions,
): Promise<QoderWireMessage[]> {
  return validateAndTranslateMessages(options.messages, options.system, attachments, options.signal, pipeline)
}

export async function prepareQoderRequest(
  options: GenerateOptions,
  userId: string,
  translatedMessages?: QoderWireMessage[],
  model?: QoderCatalogModel,
  attachments?: QoderImageAttachments,
  tracker: QoderTurnTracker = qoderTurnTracker,
  identityScope = '',
  hostRun?: QoderHostRun,
): Promise<PreparedQoderRequest> {
  if (!userId) throw new QoderLlmError('Qoder request identity is missing.', 'AUTH')
  if (translatedMessages === undefined) validateQoderRequestShape(options, model)
  const messages = translatedMessages ?? await translateQoderMessages(options, attachments)
  const modelKey = options.model || 'cmodel'
  const modelMaxTokens = model?.maxTokens ?? 32_768
  const maxTokens = Math.min(options.maxTokens ?? modelMaxTokens, modelMaxTokens)
  const isReasoning = options.reasoningEffort !== undefined || (model?.isReasoning ?? false)
  const selectedTier = model === undefined ? undefined : selectedContextTier(model)
  const defaultContexts = Object.values(model?.contextOptions ?? {}).filter(option =>
    option.isDefault === true && typeof option.tokenCount === 'number'
    && Number.isFinite(option.tokenCount) && option.tokenCount > 0)
  const contextConfig = model?.contextOptions === undefined
    || (selectedTier === undefined && defaultContexts.length !== 1)
    ? undefined
    : Object.fromEntries(Object.entries(model.contextOptions).map(([key, value]) => [key, {
      ...value.tokenCount === undefined ? {} : { token_count: value.tokenCount },
      ...selectedTier === undefined
        ? value.isDefault === undefined ? {} : { is_default: value.isDefault }
        : { is_default: key === selectedTier.key },
    }]))
  const contextLength = selectedTier?.tokenCount ?? model?.contextWindow
  let lastUserText = ''
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.role === 'user') {
      lastUserText = wireMessageText(message)
      break
    }
  }
  const requestId = crypto.randomUUID()
  const sessionIdParam = String(options.sessionId ?? '') || undefined
  const wireSessionId = sessionIdParam === undefined ? undefined : qoderSessionId(userId, sessionIdParam, identityScope)
  const standaloneMessages = userMessagesBeforeImageTrimming(messages)
  const identity = tracker.resolveTurnIdentity(
    sessionIdParam === undefined ? undefined : JSON.stringify([identityScope, userId, sessionIdParam]),
    messages,
    callKind(options),
    requestId,
    modelKey,
    hostRun,
    {
      scope: JSON.stringify([identityScope, userId]),
      ...wireSessionId === undefined ? {} : { sessionId: wireSessionId },
      ...standaloneMessages === undefined ? {} : { standaloneMessages },
    },
  )
  return {
    requestId,
    requestSetId: identity.requestSetId,
    chatRecordId: identity.chatRecordId,
    sessionId: identity.sessionId,
    taskId: 'common',
    modelKey,
    modelSource: model?.source || 'system',
    messages,
    tools: translateTools(options.tools),
    maxTokens,
    ...contextLength === undefined ? {} : { contextLength },
    ...options.reasoningEffort === undefined ? {} : { reasoningEffort: String(options.reasoningEffort) },
    isReasoning,
    ...contextConfig === undefined ? {} : { contextConfig },
    lastUserText,
    business: {
      product: 'cli',
      version: qoderIdeVersion,
      type: 'agent',
      stage: identity.businessStage,
      id: identity.businessId,
      name: identity.businessName,
      begin_at: identity.beginAt,
    },
  }
}
