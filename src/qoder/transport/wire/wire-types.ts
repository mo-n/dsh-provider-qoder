/**
 * Legacy COSY model-route envelope types. Shared model values live in model-types.ts.
 *
 * @module dsh-provider-qoder/qoder/transport/wire/wire-types
 */

import type { QoderBusiness, QoderContextConfig, QoderWireMessage, QoderWireTextPart, QoderWireTool } from './model-types.ts'
export type * from './model-types.ts'

export interface QoderModelConfig {
  key: string
  is_reasoning: boolean
  max_output_tokens: number
  source: string
  context_config?: QoderContextConfig
}

export interface QoderChatContext {
  chatPrompt: string
  imageUrls: null | string[]
  extra: {
    context: unknown[]
    modelConfig: {
      key: string
      is_reasoning: boolean
    }
    originalContent: string
  }
  features: unknown[]
  text: string
}

export interface QoderWireRequest {
  request_id: string
  request_set_id: string
  chat_record_id: string
  session_id: string
  stream: true
  chat_task: string
  is_reply: boolean
  is_retry: boolean
  source: number
  version: string
  session_type: string
  agent_id: string
  task_id: string
  code_language: string
  chat_prompt: string
  image_urls: null
  aliyun_user_type: string
  system: QoderWireTextPart[]
  messages: QoderWireMessage[]
  tools: QoderWireTool[]
  parameters: {
    max_tokens: number
    reasoning_effort?: string
    context_length?: number
  }
  chat_context: QoderChatContext
  model_config: QoderModelConfig
  business: QoderBusiness
}

export interface QoderSseEnvelope {
  statusCodeValue?: number
  statusCode?: number | string
  message?: string
  body?: unknown
}
