/** Translate provider-neutral DSH messages and tools into Qoder wire values. */

import type { ContentBlock, ImageBlock, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import { QoderLlmError } from '../../errors.ts'
import type { CosyCredentials } from './cosy.ts'
import type {
  QoderWireImagePart,
  QoderWireMessage,
  QoderWireTextPart,
  QoderWireTool,
  QoderWireToolCall,
} from './wire-types.ts'

/** Legacy hosts wrap tool results in content blocks; current hosts use role: tool. */
interface ToolResultBlock {
  type: 'tool-result'
  toolCallId?: string
  content: readonly ContentBlock[]
}

interface QoderMessage {
  role: string
  content: readonly (ContentBlock | ToolResultBlock)[]
  source?: unknown
}

export type QoderImageAttachments = Pick<AttachmentStore, 'imageLimits' | 'readImageRequest'>

/** Publishes a request image and returns the URL the wire message should carry. */
export interface QoderImageResolver {
  resolveImageUrl(
    image: RequestImageAttachment,
    credentials: CosyCredentials,
    signal?: AbortSignal,
  ): Promise<string>
}

export interface QoderTranslateContext {
  attachments?: QoderImageAttachments
  uploader?: QoderImageResolver
  credentials?: CosyCredentials
  signal?: AbortSignal
}

function unsupported(message: string): QoderLlmError {
  return new QoderLlmError(message, 'UNSUPPORTED_CONTENT')
}

function toolResultText(block: ToolResultBlock): string {
  let text = ''
  for (const nested of block.content) {
    if (nested.type === 'image') continue
    if (nested.type !== 'text') {
      throw unsupported(`Qoder tool results support text only; received nested ${String(nested.type)} content.`)
    }
    text += nested.text
  }
  return text
}

/** Reject a batch that exceeds the deployment image policy before any upload work starts. */
function enforceImageLimits(
  images: readonly ImageBlock[],
  attachments: QoderImageAttachments,
): void {
  const limits = attachments.imageLimits
  if (images.length > limits.maxImagesPerMessage) {
    throw unsupported(
      `Qoder accepts at most ${limits.maxImagesPerMessage} images per message; received ${images.length}.`,
    )
  }
  let total = 0
  for (const image of images) total += image.attachment.bytes
  if (total > limits.maxMessageImageBytes) {
    throw unsupported('Qoder message image content exceeds the configured total byte limit.')
  }
}

async function resolveImagePart(
  block: ImageBlock,
  context: QoderTranslateContext,
): Promise<QoderWireImagePart> {
  const { attachments, uploader, credentials, signal } = context
  if (attachments === undefined) {
    throw new QoderLlmError('Qoder image input requires the DSH attachment service.', 'ATTACHMENT')
  }
  let image: RequestImageAttachment
  try {
    const limits = attachments.imageLimits
    const { width, height } = block.attachment
    const scale = Math.min(1, Math.sqrt(limits.maxImagePixels / (width * height)),
      limits.maxImageDimension / width, limits.maxImageDimension / height)
    const target = {
      width: Math.max(1, Math.floor(width * scale)),
      height: Math.max(1, Math.floor(height * scale)),
      maxBytes: limits.maxImageBytes,
      // Older attachment services choose their own dimensions from this bound.
      maxPixels: limits.maxImagePixels,
    }
    image = await attachments.readImageRequest(block.attachment, target, signal)
  } catch (error) {
    if (signal?.aborted) throw new QoderLlmError('Qoder image preparation was aborted.', 'ABORTED', { cause: error })
    if (error instanceof QoderLlmError) throw error
    throw new QoderLlmError('Qoder could not prepare an image attachment.', 'ATTACHMENT', { cause: error })
  }

  // Publication degrades to an inline data URL on its own; only a missing
  // uploader or missing credentials skips the center exchange entirely.
  if (uploader !== undefined && credentials !== undefined) {
    const url = await uploader.resolveImageUrl(image, credentials, signal)
    return { type: 'image_url', image_url: { url } }
  }
  return {
    type: 'image_url',
    image_url: { url: `data:${image.mediaType};base64,${Buffer.from(image.data).toString('base64')}` },
  }
}

export function translateTools(tools: readonly ToolSchema[] | undefined): QoderWireTool[] {
  return (tools ?? []).map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }))
}

/** Read a named property from an untyped object, returning it only if present. */
function prop(obj: unknown, key: string): unknown {
  return obj !== null && obj !== undefined && typeof obj === 'object'
    ? (obj as Record<string, unknown>)[key]
    : undefined
}

/** Coerce a candidate value to a non-empty string tool call id, or `undefined`. */
function asCallId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function extractToolCallId(message: QoderMessage, result?: ToolResultBlock): string | undefined {
  // Check legacy DSH block, modern DSH message, wire-compat field, or tool source.
  return asCallId(prop(result, 'toolCallId'))
    ?? asCallId(prop(message, 'toolCallId'))
    ?? asCallId(prop(message, 'tool_call_id'))
    ?? asCallId(prop(message.source, 'kind') === 'tool' ? prop(message.source, 'callId') : undefined)
}

function consumeToolCallId(
  message: QoderMessage,
  result: ToolResultBlock | undefined,
  pendingIds: string[],
  fallbackIndex: number,
): string {
  const explicit = extractToolCallId(message, result)
  if (explicit !== undefined) {
    const idx = pendingIds.indexOf(explicit)
    if (idx !== -1) {
      pendingIds.splice(idx, 1)
    }
    return explicit
  }
  return pendingIds.shift() ?? `call_unknown_${fallbackIndex}`
}

export async function validateAndTranslateMessages(
  messages: readonly QoderMessage[],
  systemPrompt?: string,
  attachments?: QoderImageAttachments,
  signal?: AbortSignal,
  pipeline?: Pick<QoderTranslateContext, 'uploader' | 'credentials'> & { preserveThinking?: boolean },
): Promise<QoderWireMessage[]> {
  const context: QoderTranslateContext = {
    attachments,
    signal,
    uploader: pipeline?.uploader,
    credentials: pipeline?.credentials,
  }
  const preserveThinking = pipeline?.preserveThinking ?? true
  const output: QoderWireMessage[] = []
  let lastAssistantToolCallIds: string[] = []

  if (typeof systemPrompt === 'string' && systemPrompt.trim().length > 0) {
    output.push({ role: 'system', content: systemPrompt })
  }

  for (const message of messages) {
    const toolResults = message.content.filter((block): block is ToolResultBlock => block.type === 'tool-result')
    const nonToolBlocks = message.content.filter(block => block.type !== 'tool-result')

    if (toolResults.length > 0) {
      for (const result of toolResults) {
        const callId = consumeToolCallId(message, result, lastAssistantToolCallIds, output.length)
        output.push({
          role: 'tool',
          tool_call_id: callId,
          content: toolResultText(result),
        })
        const images = result.content.filter((block): block is ImageBlock => block.type === 'image')
        if (images.length > 0) {
          if (attachments !== undefined) enforceImageLimits(images, attachments)
          output.push({
            role: 'user',
            content: [
              {
                type: 'text',
                text: `[${images.length} image${images.length === 1 ? '' : 's'} returned by the previous tool call]`,
              },
              ...await Promise.all(images.map(image => resolveImagePart(image, context))),
            ],
          })
        }
      }
      if (nonToolBlocks.length === 0) {
        continue
      }
    }

    const contentBlocks = toolResults.length > 0 ? nonToolBlocks : message.content

    let text = ''
    let reasoningText = ''
    const userContent: Array<QoderWireTextPart | QoderWireImagePart | undefined> = []
    const pendingImages: Array<{ slot: number; block: ImageBlock }> = []
    let hasImage = false
    const toolCalls: QoderWireToolCall[] = []
    for (const block of contentBlocks) {
      if (message.role === 'tool' && block.type !== 'text' && block.type !== 'image') {
        throw unsupported(`Qoder tool results support text and images only; received ${block.type} content.`)
      }
      if (block.type === 'text') {
        text += block.text
        if (message.role === 'user' || toolResults.length > 0) userContent.push({ type: 'text', text: block.text })
        continue
      }
      if (block.type === 'image') {
        if (message.role !== 'user' && message.role !== 'tool' && toolResults.length === 0) {
          throw unsupported('Qoder image content is valid only in user messages.')
        }
        hasImage = true
        // Reserve the slot now so publication can proceed concurrently
        // without disturbing the author's content order.
        pendingImages.push({ slot: userContent.length, block })
        userContent.push(undefined)
        continue
      }
      if (block.type === 'tool-call') {
        toolCalls.push({
          id: String(block.id),
          type: 'function',
          function: { name: block.name, arguments: block.arguments },
        })
        continue
      }
      if (block.type === 'reasoning') {
        if (message.role === 'assistant') reasoningText += block.text
        continue
      }
    }

    if (message.role === 'assistant') {
      const hasReasoning = preserveThinking && reasoningText.length > 0
      if (!text && toolCalls.length === 0 && !hasReasoning) continue
      if (toolCalls.length > 0) {
        lastAssistantToolCallIds = toolCalls.map(tc => tc.id)
      }
      output.push({
        role: 'assistant',
        content: text || ' ',
        ...toolCalls.length === 0 ? {} : { tool_calls: toolCalls },
        ...hasReasoning ? { reasoning_content: reasoningText } : {},
      })
      continue
    }

    if ((message.role as string) === 'tool') {
      const callId = consumeToolCallId(message, undefined, lastAssistantToolCallIds, output.length)
      output.push({
        role: 'tool',
        tool_call_id: callId,
        content: text,
      })
      if (pendingImages.length > 0) {
        if (attachments !== undefined) {
          enforceImageLimits(pendingImages.map(pending => pending.block), attachments)
        }
        output.push({
          role: 'user',
          content: [
            {
              type: 'text',
              text: `[${pendingImages.length} image${pendingImages.length === 1 ? '' : 's'} returned by the previous tool call]`,
            },
            ...await Promise.all(pendingImages.map(pending => resolveImagePart(pending.block, context))),
          ],
        })
      }
      continue
    }

    if (pendingImages.length > 0) {
      if (attachments !== undefined) {
        enforceImageLimits(pendingImages.map(pending => pending.block), attachments)
      }
      await Promise.all(pendingImages.map(async (pending) => {
        userContent[pending.slot] = await resolveImagePart(pending.block, context)
      }))
    }

    if (toolResults.length > 0 && !hasImage && text.trim().length === 0) {
      continue
    }

    const wireRole = (toolResults.length > 0 ? 'user' : message.role) as 'system' | 'user' | 'assistant' | 'tool'
    const wireToolCallId = wireRole === 'tool'
      ? consumeToolCallId(message, undefined, lastAssistantToolCallIds, output.length)
      : undefined
    output.push({
      role: wireRole,
      content: hasImage
        ? userContent.filter((part): part is QoderWireTextPart | QoderWireImagePart => part !== undefined)
        : text,
      ...wireToolCallId ? { tool_call_id: wireToolCallId } : {},
    })
  }

  return output
}
