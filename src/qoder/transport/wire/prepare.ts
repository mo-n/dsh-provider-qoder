/** Shared model request preparation, before selecting a wire protocol. */

import type { QoderHostRun } from '../../turn.ts'

import crypto from 'node:crypto'
import { type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { selectedContextTier, type QoderCatalogModel } from '../../catalog.ts'
import { QoderLlmError } from '../../errors.ts'
import type { QoderCredentials } from './credentials.ts'
import { qoderIdeVersion } from './client-identity.ts'
import { translateTools, validateAndTranslateMessages, validateMessageShapes } from './translate.ts'
import type { QoderImageAttachments, QoderImageResolver } from './translate.ts'
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

function stableHash(prefix: string, ...inputs: string[]): string {
  const hash = crypto.createHash('sha256')
  hash.update(prefix)
  for (const input of inputs) {
    hash.update('\0')
    hash.update(input)
  }
  return hash.digest('hex').slice(0, 16)
}

/** One tracker preserves agent-run identity across both model protocols. */
export const qoderTurnTracker = new QoderTurnTracker()

function callKind(options: GenerateOptions): QoderCallKind {
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
  pipeline?: { uploader?: QoderImageResolver; credentials?: QoderCredentials; preserveThinking?: boolean },
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
    if (messages[index].role === 'user') {
      lastUserText = wireMessageText(messages[index])
      break
    }
  }
  const stablePart = stableHash('qoder-session', userId)
  const sessionId = options.sessionId === undefined
    ? `${stablePart}-${crypto.randomUUID()}` : `${stablePart}-${String(options.sessionId)}`
  const requestId = crypto.randomUUID()
  const sessionIdParam = options.sessionId === undefined ? undefined : String(options.sessionId)
  const identity = tracker.resolveTurnIdentity(sessionIdParam === undefined ? undefined : JSON.stringify([identityScope, userId, sessionIdParam]), messages, callKind(options), requestId, modelKey, hostRun)
  return {
    requestId,
    requestSetId: identity.requestSetId,
    chatRecordId: identity.chatRecordId,
    sessionId,
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
      name: lastUserText.substring(0, 30),
      begin_at: identity.beginAt,
    },
  }
}
