import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ToolCallId,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  ReasoningEffortId,
  type GenerateOptions,
  type Message,
} from '@deepseek-ai/dsh-llm'
import { QoderLlmError } from '../src/qoder/errors.ts'
import { buildQoderRequestBody } from '../src/qoder/transport/wire/serialize.ts'
import {
  validateAndTranslateMessages,
  type QoderImageAttachments,
} from '../src/qoder/transport/wire/translate.ts'

const imageRef = {
  attachmentId: 'sha256:image-1' as never,
  mediaType: 'image/png' as const,
  bytes: 3,
  width: 1,
  height: 1,
}

function imageAttachments(onRead?: () => void): QoderImageAttachments {
  return {
    imageLimits: {
      maxImageBytes: 5 * 1024 * 1024,
      maxImagesPerMessage: 20,
      maxMessageImageBytes: 100 * 1024 * 1024,
      maxImagePixels: 40_000_000,
      maxImageDimension: 2_000,
      mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    },
    async readImageRequest(attachment) {
      onRead?.()
      return {
        variantId: 'sha256:variant-1' as never,
        attachment,
        data: new Uint8Array([1, 2, 3]),
        mediaType: 'image/png',
        bytes: 3,
        width: 1,
        height: 1,
        depth: 'uchar',
        space: 'srgb',
        hasAlpha: true,
      }
    },
  }
}

test('validateAndTranslateMessages processes DSH text history', async () => {
  const messages = [
    createUserMessage({ content: [{ type: 'text', text: 'Hello' }], source: { kind: 'user' } }),
    createAssistantMessage({
      content: [{ type: 'text', text: 'Hi there!' }],
      source: {
        provider: 'qoder-official',
        model: 'cmodel',
      },
    }),
  ]
  assert.deepEqual(await validateAndTranslateMessages(messages, 'System'), [
    { role: 'system', content: 'System' },
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Hi there!' },
  ])
})

test('validateAndTranslateMessages projects tool history and omits assistant reasoning', async () => {
  const callId = ToolCallId('call-1')
  const assistant = createAssistantMessage({
    content: [
      { type: 'reasoning', text: 'The prior scratch work is not replayed.' },
      { type: 'text', text: 'I will add the values.' },
      { type: 'tool-call', id: callId, name: 'add', arguments: '{"a":2,"b":3}' },
    ],
    source: { provider: 'qoder-official', model: 'cmodel' },
  })
  const result = createToolResultMessage({
    callId,
    content: [{ type: 'text', text: '5' }, { type: 'text', text: ' total' }],
    isError: false,
  })
  assert.deepEqual(await validateAndTranslateMessages([assistant, result]), [
    {
      role: 'assistant',
      content: 'I will add the values.',
      tool_calls: [{
        id: 'call-1',
        type: 'function',
        function: { name: 'add', arguments: '{"a":2,"b":3}' },
      }],
    },
    { role: 'tool', tool_call_id: 'call-1', content: '5 total' },
  ])
})

test('validateAndTranslateMessages keeps tool-only assistant messages and drops reasoning-only history', async () => {
  const callId = ToolCallId('call-2')
  const toolOnly = createAssistantMessage({
    content: [{ type: 'tool-call', id: callId, name: 'ping', arguments: '{}' }],
    source: { provider: 'qoder-official', model: 'cmodel' },
  })
  const reasoningOnly = createAssistantMessage({
    content: [{ type: 'reasoning', text: 'transient' }],
    source: { provider: 'qoder-official', model: 'cmodel' },
  })
  assert.deepEqual(await validateAndTranslateMessages([toolOnly, reasoningOnly]), [{
    role: 'assistant',
    content: ' ',
    tool_calls: [{ id: 'call-2', type: 'function', function: { name: 'ping', arguments: '{}' } }],
  }])
})

test('validateAndTranslateMessages inlines user images as ordered OpenAI data URLs', async () => {
  const message = createUserMessage({
    content: [
      { type: 'text', text: 'before' },
      { type: 'image', attachment: imageRef },
      { type: 'text', text: 'after' },
    ],
    source: { kind: 'user' },
  })

  assert.deepEqual(await validateAndTranslateMessages([message], undefined, imageAttachments()), [{
    role: 'user',
    content: [
      { type: 'text', text: 'before' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } },
      { type: 'text', text: 'after' },
    ],
  }])
})

test('validateAndTranslateMessages forwards tool-result images in a following user message', async () => {
  const result = createToolResultMessage({
    callId: ToolCallId('call-image'),
    content: [{ type: 'text', text: 'captured' }, { type: 'image', attachment: imageRef }],
    isError: false,
  })

  assert.deepEqual(await validateAndTranslateMessages([result], undefined, imageAttachments()), [
    { role: 'tool', tool_call_id: 'call-image', content: 'captured' },
    {
      role: 'user',
      content: [
        { type: 'text', text: '[1 image returned by the previous tool call]' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } },
      ],
    },
  ])
})

test('validateAndTranslateMessages rejects assistant images and non-image tool-result content', async () => {
  const invalidMessages = [
    createAssistantMessage({
      content: [{ type: 'image' } as never],
      source: { provider: 'qoder-official', model: 'cmodel' },
    }),
    createToolResultMessage({ callId: ToolCallId('call-invalid'), content: [{ type: 'reasoning', text: 'no' }], isError: false }),
  ]
  for (const message of invalidMessages) {
    await assert.rejects(() => validateAndTranslateMessages([message]), (error: Error) => {
      assert.ok(error instanceof QoderLlmError)
      assert.equal((error as QoderLlmError).code, 'UNSUPPORTED_CONTENT')
      return true
    })
  }
})

test('buildQoderRequestBody uses the resolved identity and configured model', async () => {
  const options = {
    provider: 'qoder-official',
    model: 'custom-model',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'Ping' }], source: { kind: 'user' } })],
    maxTokens: 4096,
    sessionId: 'session-1',
  } as GenerateOptions
  const body = await buildQoderRequestBody(options, 'user-42')
  assert.equal(body.session_type, 'qodercli')
  assert.equal(body.model_config.key, 'custom-model')
  assert.equal(body.parameters.max_tokens, 4096)
  assert.match(body.session_id, /^[a-f0-9]{16}-session-1$/)
})

test('buildQoderRequestBody applies discovered Qoder transport metadata', async () => {
  const options = {
    provider: 'qoder-official',
    model: 'reasoner',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'Think' }], source: { kind: 'user' } })],
    maxTokens: 32_000,
  } as GenerateOptions
  const body = await buildQoderRequestBody(options, 'user-42', undefined, {
    id: 'reasoner',
    name: 'Reasoner',
    maxTokens: 16_000,
    source: 'premium',
    isReasoning: true,
    contextOptions: { long: { tokenCount: 400_000, isDefault: true } },
  })
  assert.equal(body.parameters.max_tokens, 16_000)
  assert.equal(body.model_config.is_reasoning, true)
  assert.equal(body.model_config.source, 'premium')
  assert.deepEqual(body.model_config.context_config, {
    long: { token_count: 400_000, is_default: true },
  })
  assert.equal(body.chat_context.extra.modelConfig.is_reasoning, true)
})

test('buildQoderRequestBody sends DSH tool declarations', async () => {
  const messages: Message[] = [createUserMessage({ content: [{ type: 'text', text: 'Hi' }], source: { kind: 'user' } })]
  const body = await buildQoderRequestBody({
    provider: 'qoder-official',
    model: 'cmodel',
    messages,
    tools: [{ name: 'tool', description: 'tool', parameters: {} }],
  }, 'user-42')
  assert.deepEqual(body.tools, [{
    type: 'function',
    function: { name: 'tool', description: 'tool', parameters: {} },
  }])
  assert.deepEqual(body.messages, [{ role: 'user', content: 'Hi' }])
})

test('buildQoderRequestBody preserves text metadata while inlining image content', async () => {
  const options = {
    provider: 'qoder-official',
    model: 'vision',
    messages: [createUserMessage({
      content: [{ type: 'text', text: 'Inspect this' }, { type: 'image', attachment: imageRef }],
      source: { kind: 'user' },
    })],
  } as GenerateOptions
  const body = await buildQoderRequestBody(
    options,
    'user-42',
    undefined,
    { id: 'vision', name: 'Vision', supportsImages: true },
    imageAttachments(),
  )

  assert.deepEqual(body.messages, [{
    role: 'user',
    content: [
      { type: 'text', text: 'Inspect this' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } },
    ],
  }])
  assert.equal(body.chat_context.text, 'Inspect this')
  assert.equal(body.chat_context.extra.originalContent, 'Inspect this')
  assert.equal(body.image_urls, null)
  assert.equal(body.chat_context.imageUrls, null)
})

test('buildQoderRequestBody accepts only advertised reasoning efforts', async () => {
  const options = {
    provider: 'qoder-official',
    model: 'reasoner',
    reasoningEffort: ReasoningEffortId('high'),
    messages: [createUserMessage({ content: [{ type: 'text', text: 'Think' }], source: { kind: 'user' } })],
  } as GenerateOptions
  const model = {
    id: 'reasoner',
    name: 'Reasoner',
    isReasoning: true,
    reasoningEfforts: [{ id: 'low', name: 'low' }, { id: 'high', name: 'high' }],
  }
  const body = await buildQoderRequestBody(options, 'user-42', undefined, model)
  assert.equal(body.parameters.reasoning_effort, 'high')

  options.reasoningEffort = ReasoningEffortId('off')
  await assert.rejects(
    () => buildQoderRequestBody(options, 'user-42', undefined, model),
    (error: Error) => error instanceof QoderLlmError && error.code === 'UNSUPPORTED_REASONING_EFFORT',
  )
})
