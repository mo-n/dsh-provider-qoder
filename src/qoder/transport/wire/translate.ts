/** Translate provider-neutral DSH messages and tools into Qoder wire values. */

import type { ContentBlock, ImageBlock, Message, ToolResultBlock, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import { QoderLlmError } from '../../errors.ts'
import type {
  QoderWireImagePart,
  QoderWireMessage,
  QoderWireTextPart,
  QoderWireTool,
  QoderWireToolCall,
} from './wire-types.ts'

export type QoderImageAttachments = Pick<AttachmentStore, 'imageLimits' | 'readImageRequest'>

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

function validateMessageShapes(messages: readonly Message[]): void {
  for (const message of messages) {
    const toolResults = message.content.filter((block): block is ToolResultBlock => block.type === 'tool-result')
    if (toolResults.length > 0) {
      if (message.role !== 'user' || toolResults.length !== message.content.length) {
        throw unsupported('Qoder tool-result messages cannot contain sibling content or use a non-user role.')
      }
      for (const result of toolResults) toolResultText(result)
      continue
    }

    for (const block of message.content) {
      if (block.type === 'text') continue
      if (block.type === 'image') {
        if (message.role !== 'user') throw unsupported('Qoder image content is valid only in user messages.')
        continue
      }
      if (block.type === 'tool-call') {
        if (message.role !== 'assistant') {
          throw unsupported('Qoder tool calls are valid only in assistant messages.')
        }
        continue
      }
      if (block.type === 'reasoning') {
        if (message.role !== 'assistant') {
          throw unsupported('Qoder historical reasoning is valid only in assistant messages.')
        }
        continue
      }
      throw unsupported(`Qoder transport encountered unsupported block type: ${String((block as ContentBlock).type)}`)
    }
  }
}

async function resolveImagePart(
  block: ImageBlock,
  attachments: QoderImageAttachments | undefined,
  signal?: AbortSignal,
): Promise<QoderWireImagePart> {
  if (attachments === undefined) {
    throw new QoderLlmError('Qoder image input requires the DSH attachment service.', 'ATTACHMENT')
  }
  try {
    const limits = attachments.imageLimits
    const image: RequestImageAttachment = await attachments.readImageRequest(block.attachment, {
      maxPixels: limits.maxImagePixels,
      maxBytes: limits.maxImageBytes,
    }, signal)
    return {
      type: 'image_url',
      image_url: { url: `data:${image.mediaType};base64,${Buffer.from(image.data).toString('base64')}` },
    }
  } catch (error) {
    if (signal?.aborted) throw new QoderLlmError('Qoder image preparation was aborted.', 'ABORTED', { cause: error })
    if (error instanceof QoderLlmError) throw error
    throw new QoderLlmError('Qoder could not prepare an image attachment.', 'ATTACHMENT', { cause: error })
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

export async function validateAndTranslateMessages(
  messages: readonly Message[],
  systemPrompt?: string,
  attachments?: QoderImageAttachments,
  signal?: AbortSignal,
): Promise<QoderWireMessage[]> {
  validateMessageShapes(messages)
  const output: QoderWireMessage[] = []

  if (typeof systemPrompt === 'string' && systemPrompt.trim().length > 0) {
    output.push({ role: 'system', content: systemPrompt })
  }

  for (const message of messages) {
    const toolResults = message.content.filter((block): block is ToolResultBlock => block.type === 'tool-result')
    if (toolResults.length > 0) {
      if (message.role !== 'user' || toolResults.length !== message.content.length) {
        throw unsupported('Qoder tool-result messages cannot contain sibling content or use a non-user role.')
      }
      for (const result of toolResults) {
        output.push({
          role: 'tool',
          tool_call_id: String(result.toolCallId),
          content: toolResultText(result),
        })
        const images = result.content.filter((block): block is ImageBlock => block.type === 'image')
        if (images.length > 0) {
          output.push({
            role: 'user',
            content: [
              {
                type: 'text',
                text: `[${images.length} image${images.length === 1 ? '' : 's'} returned by the previous tool call]`,
              },
              ...await Promise.all(images.map(image => resolveImagePart(image, attachments, signal))),
            ],
          })
        }
      }
      continue
    }

    let text = ''
    const userContent: Array<QoderWireTextPart | QoderWireImagePart> = []
    let hasImage = false
    const toolCalls: QoderWireToolCall[] = []
    for (const block of message.content) {
      if (block.type === 'text') {
        text += block.text
        if (message.role === 'user') userContent.push({ type: 'text', text: block.text })
        continue
      }
      if (block.type === 'image') {
        hasImage = true
        userContent.push(await resolveImagePart(block, attachments, signal))
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
        continue
      }
    }

    if (message.role === 'assistant') {
      if (!text && toolCalls.length === 0) continue
      output.push({
        role: 'assistant',
        content: text || ' ',
        ...toolCalls.length === 0 ? {} : { tool_calls: toolCalls },
      })
      continue
    }
    output.push({ role: message.role, content: hasImage ? userContent : text })
  }

  return output
}
