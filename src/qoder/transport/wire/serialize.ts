/** Encode a prepared Qoder model request for the legacy COSY model route. */

import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { QoderCatalogModel } from '../../catalog.ts'
import type { QoderImageAttachments } from './translate.ts'
import { prepareQoderRequest } from './prepare.ts'
import type { QoderWireMessage, QoderWireRequest } from './wire-types.ts'
import type { QoderTurnTracker } from './turn-identity.ts'

// Preserve the established internal imports while the route-specific encoder
// uses the shared preparation module.
export { qoderTurnTracker, translateQoderMessages, validateQoderRequestShape } from './prepare.ts'

export async function buildQoderRequestBody(
  options: GenerateOptions,
  userId: string,
  translatedMessages?: QoderWireMessage[],
  model?: QoderCatalogModel,
  attachments?: QoderImageAttachments,
  tracker?: QoderTurnTracker,
  identityScope = '',
): Promise<QoderWireRequest> {
  const prepared = await prepareQoderRequest(options, userId, translatedMessages, model, attachments, tracker, identityScope)
  return {
    request_id: prepared.requestId,
    request_set_id: prepared.requestSetId,
    chat_record_id: prepared.chatRecordId,
    session_id: prepared.sessionId,
    stream: true,
    chat_task: 'FREE_INPUT',
    is_reply: true,
    is_retry: false,
    source: 1,
    version: '3',
    session_type: 'qodercli',
    agent_id: 'agent_common',
    task_id: prepared.taskId,
    code_language: '',
    chat_prompt: '',
    image_urls: null,
    aliyun_user_type: '',
    system: prepared.messages.filter(message => message.role === 'system').flatMap(message =>
      typeof message.content === 'string' && message.content.length > 0
        ? [{ type: 'text' as const, text: message.content }] : []),
    messages: prepared.messages,
    tools: prepared.tools,
    parameters: {
      max_tokens: prepared.maxTokens,
      ...prepared.contextLength === undefined ? {} : { context_length: prepared.contextLength },
      ...prepared.reasoningEffort === undefined ? {} : { reasoning_effort: prepared.reasoningEffort },
    },
    chat_context: {
      chatPrompt: '',
      imageUrls: null,
      extra: {
        context: [],
        modelConfig: { key: prepared.modelKey, is_reasoning: prepared.isReasoning },
        originalContent: prepared.lastUserText,
      },
      features: [],
      text: prepared.lastUserText,
    },
    model_config: {
      key: prepared.modelKey,
      is_reasoning: prepared.isReasoning,
      max_output_tokens: prepared.maxTokens,
      source: prepared.modelSource,
      ...prepared.contextConfig === undefined ? {} : { context_config: prepared.contextConfig },
    },
    business: prepared.business,
  }
}
