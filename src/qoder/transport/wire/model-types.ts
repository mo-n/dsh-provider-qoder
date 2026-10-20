/** Values shared by Qoder's model protocols before route-specific encoding. */

export interface QoderWireToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface QoderWireTool {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export interface QoderWireTextPart {
  type: 'text'
  text: string
}

export interface QoderWireImagePart {
  type: 'image_url'
  image_url: { url: string }
}

export type QoderWireContent = string | Array<QoderWireTextPart | QoderWireImagePart>

export interface QoderWireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: QoderWireContent | null
  tool_calls?: QoderWireToolCall[]
  tool_call_id?: string
  reasoning_content?: string
}

export interface QoderBusiness {
  product: string
  version: string
  type: string
  stage: string
  id: string
  name: string
  begin_at: number
}

export type QoderContextConfig = Record<string, { token_count?: number; is_default?: boolean }>

export interface QoderInnerChunk {
  id?: string
  model?: string
  choices?: Array<{
    index?: number
    delta?: {
      content?: string
      role?: string
      reasoning_content?: string
      tool_calls?: Array<{
        index?: number
        id?: string
        type?: string
        function?: { name?: string; arguments?: string }
      }>
    } | null
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number }
    completion_tokens_details?: { reasoning_tokens?: number }
  }
}
