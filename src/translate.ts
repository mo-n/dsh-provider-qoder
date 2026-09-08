/** Translate provider-neutral DSH messages and tools into Qoder wire values. */

import type { ContentBlock, Message, ToolResultBlock, ToolSchema } from '@deepseek-ai/dsh-llm'
import { QoderLlmError } from './errors.ts'
import type { QoderWireMessage, QoderWireTool, QoderWireToolCall } from './types.ts'

function unsupported(message: string): QoderLlmError {
  return new QoderLlmError(message, 'UNSUPPORTED_CONTENT')
}

function toolResultText(block: ToolResultBlock): string {
  let text = ''
  for (const nested of block.content) {
    if (nested.type !== 'text') {
      throw unsupported(`Qoder tool results support text only; received nested ${String(nested.type)} content.`)
    }
    text += nested.text
  }
  return text
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

export function validateAndTranslateMessages(
  messages: readonly Message[],
  systemPrompt?: string,
): QoderWireMessage[] {
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
      }
      continue
    }

    let text = ''
    const toolCalls: QoderWireToolCall[] = []
    for (const block of message.content) {
      if (block.type === 'text') {
        text += block.text
        continue
      }
      if (block.type === 'image') {
        throw unsupported('Qoder transport does not support image content.')
      }
      if (block.type === 'tool-call') {
        if (message.role !== 'assistant') {
          throw unsupported('Qoder tool calls are valid only in assistant messages.')
        }
        toolCalls.push({
          id: String(block.id),
          type: 'function',
          function: { name: block.name, arguments: block.arguments },
        })
        continue
      }
      if (block.type === 'tool-result') {
        throw unsupported('Qoder encountered an invalid mixed tool-result message.')
      }
      if (block.type === 'reasoning') {
        if (message.role !== 'assistant') {
          throw unsupported('Qoder historical reasoning is valid only in assistant messages.')
        }
        continue
      }
      throw unsupported(`Qoder transport encountered unsupported block type: ${String((block as ContentBlock).type)}`)
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
    output.push({ role: message.role, content: text })
  }

  return output
}
