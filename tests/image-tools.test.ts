import assert from 'node:assert/strict'
import { test, mock } from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'
import { ToolRuntime, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import LlmRuntime, { LlmAdapter, ToolCallId, createToolResultMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { QoderTransport } from '../src/qoder/transport/index.ts'
import { bindQoderImageTools, QoderImageArtifactDeliveryError } from '../src/dsh/image-tools.ts'
import { imageArtifactName } from '../src/dsh/image-artifacts.ts'
import { validateAndTranslateMessages } from '../src/qoder/transport/wire/translate.ts'
import { QoderImageSearchError } from '../src/qoder/images.ts'

function fixture(options: { files?: boolean; missingCapability?: 'saveFile' | 'fileHostPath' | 'processPathFromHostPath'; failSave?: boolean; noPath?: boolean } = {}) {
  const tools = new Map<string, ToolDefinition>()
  const effects: Array<() => void> = []
  const writes: Array<{ data: Uint8Array; name: string }> = []
  let searchEnabled = true
  let genEnabled = true
  const calls: unknown[] = []
  const logs: Array<{ level: string; details: Record<string, unknown> }> = []
  let generate = async (request: unknown) => {
    calls.push(request)
    return { bytes: new Uint8Array([1, 2, 3]), mediaType: 'image/png', requestId: 'generated-id', imageUrl: 'https://images.example/result.png' }
  }
  const transport = {
    searchImages: async (request: unknown) => { calls.push(request); return { requestId: 'search-id', results: [{ imageUrl: 'https://images.example/result.png', width: 100 }] } },
    generateImage: (request: unknown) => generate(request),
  } as unknown as QoderTransport
  const fs = { processPathFromHostPath: (path: string) => options.noPath ? undefined : path }
  const ctx = {
    tools: { register: (tool: ToolDefinition) => { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
    attachments: {
      saveFile: async ({ data, name }: { data: Uint8Array; name: string }) => {
        if (options.failSave) throw new Error('disk full')
        writes.push({ data, name })
        return { attachmentId: 'stored-image', name, bytes: data.length }
      },
      fileHostPath: ({ name }: { name: string }) => `/attachments/${name}`,
    },
    get: (name: string) => name === 'fs' && options.files !== false ? fs : undefined,
    inject: (dependencies: string[], callback: (ctx: unknown) => void) => {
      if (options.files === false && dependencies.includes('fs')) return
      callback(ctx)
    },
    effect: (factory: () => () => void) => { effects.push(factory()) },
  }
  if (options.missingCapability === 'processPathFromHostPath') Reflect.deleteProperty(fs, options.missingCapability)
  else if (options.missingCapability) Reflect.deleteProperty(ctx.attachments, options.missingCapability)
  const binding = bindQoderImageTools(ctx as unknown as Context, {
    logger: {
      debug: (_message, details) => logs.push({ level: 'debug', details: details as Record<string, unknown> }),
      warn: (_message, details) => logs.push({ level: 'warn', details: details as Record<string, unknown> }),
    },
    resolveTransport: () => transport,
    getImageSearchEnabled: () => searchEnabled,
    getImageGenEnabled: () => genEnabled,
    captureHostRun: () => ({ id: 'run-id' }),
  })
  const exec = { signal: new AbortController().signal, agent: { session: { id: 'session-id' } } } as ToolRunContext
  return {
    tools, writes, calls, exec, logs,
    setSearch(value: boolean) { searchEnabled = value; binding.refresh() },
    setGeneration(value: boolean) { genEnabled = value; binding.refresh() },
    setGenerate(value: typeof generate) { generate = value },
    setSearchImages(value: NonNullable<QoderTransport['searchImages']>) { transport.searchImages = value },
    dispose() { for (const dispose of effects.reverse()) dispose() },
  }
}

test('attachment diagnostics correlate successful and failed storage without logging filenames or URLs', async () => {
  for (const failSave of [false, true]) {
    const f = fixture({ failSave })
    const result = f.tools.get('ImageGen')!.execute({ name: 'private-filename', prompt: 'private-prompt' }, f.exec)
    if (failSave) await assert.rejects(result)
    else await result
    assert.equal(f.logs.length, 2)
    assert.equal(f.logs[1].level, failSave ? 'warn' : 'debug')
    assert.ok(f.logs.every(log => log.details.requestId === 'generated-id' && log.details.stage === 'attachment-save'))
    assert.ok(!/private-|https:/.test(JSON.stringify(f.logs)))
    f.dispose()
  }
})

test('image tools independently unregister and reject retained schemas', async () => {
  const f = fixture()
  const search = f.tools.get('ImageSearch')!
  const generation = f.tools.get('ImageGen')!
  f.setSearch(false)
  assert.deepEqual([...f.tools.keys()], ['ImageGen'])
  await assert.rejects(search.execute({ query: 'cat' }, f.exec), /disabled/)
  f.setGeneration(false)
  assert.equal(f.tools.size, 0)
  await assert.rejects(generation.execute({ name: 'cat', prompt: 'cat' }, f.exec), /disabled/)
  assert.equal(f.calls.length, 0)
  f.setSearch(true)
  assert.deepEqual([...f.tools.keys()], ['ImageSearch'])
  f.dispose()
  assert.equal(f.tools.size, 0)
})

test('image search bounds parameters and truncates by Unicode code point', async () => {
  const f = fixture()
  const search = f.tools.get('ImageSearch')!
  await search.execute({ query: '😺'.repeat(101) }, f.exec)
  assert.deepEqual(f.calls, [{ query: '😺'.repeat(100), count: 5 }])
  for (const count of [0, 11, 1.5]) await assert.rejects(search.execute({ query: 'cat', count }, f.exec))
  await assert.rejects(search.execute({ query: ' ' }, f.exec), /non-empty/)
  assert.equal(f.calls.length, 1)
})

test('image search JSON includes the clipped query and measured duration for populated and empty results', async () => {
  for (const results of [[{ imageUrl: 'https://images.example/result.png', width: 0 }], []]) {
    const f = fixture()
    const tool = f.tools.get('ImageSearch')!
    let clock = 10_000
    const timing = mock.method(performance, 'now', () => clock)
    f.setSearchImages(async request => {
      f.calls.push(request)
      clock += 2500
      return { requestId: 'timed-search', results }
    })
    try {
      const result = await tool.execute({ query: '😺'.repeat(101) }, f.exec)
      const expected = { query: '😺'.repeat(100), durationSeconds: 2.5, results, requestId: 'timed-search' }
      assert.deepEqual(result, expected)
      assert.deepEqual(f.calls, [{ query: expected.query, count: 5 }])
      assert.deepEqual(tool.output.render({}, result as never), [{ type: 'text', text: JSON.stringify(expected) }])
    } finally { timing.mock.restore(); f.dispose() }
  }
})

test('image search tools preserve classified errors and cancellation', async () => {
  const f = fixture()
  const tool = f.tools.get('ImageSearch')!
  const error = new QoderImageSearchError('auth', 'search-id', { httpStatus: 403 })
  f.setSearchImages(async () => { throw error })
  await assert.rejects(tool.execute({ query: 'cat' }, f.exec), actual => actual === error)
  const controller = new AbortController()
  f.setSearchImages(async () => { controller.abort(); return { requestId: 'cancelled', results: [] } })
  await assert.rejects(tool.execute({ query: 'cat' }, { ...f.exec, signal: controller.signal }), actual => actual === controller.signal.reason)
  f.dispose()
})

test('generation preserves original bytes and turn identity without a vision model', async () => {
  const f = fixture()
  const tool = f.tools.get('ImageGen')!
  const result = await tool.execute({ name: '../../cat.png', prompt: 'cat' }, f.exec) as { path: string; requestId: string }
  assert.equal(result.requestId, 'generated-id')
  assert.match(result.path, /^\/attachments\/cat-[\da-f-]+\.png$/)
  assert.deepEqual([...f.writes[0]!.data], [1, 2, 3])
  assert.deepEqual(f.calls, [{ prompt: 'cat', size: undefined, sessionId: 'session-id', hostRun: { id: 'run-id' } }])
  const blocks = tool.output.render({}, result as never)
  assert.equal(blocks[1]?.type, 'file')
})

test('a disabled switch does not cancel generation already in progress', async () => {
  const f = fixture()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  f.setGenerate(async request => { f.calls.push(request); await gate; return { bytes: new Uint8Array([5]), mediaType: 'image/png', requestId: 'in-flight', imageUrl: 'https://images.example/result.png' } })
  const pending = f.tools.get('ImageGen')!.execute({ name: 'cat', prompt: 'cat' }, f.exec)
  f.setGeneration(false)
  release()
  const result = await pending as { requestId: string }
  assert.equal(result.requestId, 'in-flight')
  assert.equal(f.writes.length, 1)
})

test('generation delivery failures retain generated status and never regenerate', async () => {
  for (const options of [{ failSave: true }, { noPath: true }]) {
    const f = fixture(options)
    await assert.rejects(f.tools.get('ImageGen')!.execute({ name: 'cat', prompt: 'cat' }, f.exec), /generated.*delivery failed.*Automatic recovery is unavailable.*Do not call ImageGen again.*report requestId=generated-id to the user/)
    assert.equal(f.calls.length, 1)
  }
  const error = new QoderImageArtifactDeliveryError('request-id', 'https://images.example/result?signature=private', new Error('disk full'))
  assert.doesNotMatch(error.message, /retry|disk full/)
  assert.equal(error.imageUrl, 'https://images.example/result?signature=private')
  assert.doesNotMatch(JSON.stringify(error), /signature=private/)
})

test('provider-only hosts do not advertise generation without mapped file delivery', () => {
  const f = fixture({ files: false })
  assert.deepEqual([...f.tools.keys()], ['ImageSearch'])
})

test('artifact display names are safe and unique', () => {
  const a = imageArtifactName('..\\../CON.png', 'image/png')
  const b = imageArtifactName('..\\../CON.png', 'image/png')
  assert.match(a, /^CON-[\da-f-]+\.png$/)
  assert.notEqual(a, b)
  assert.match(imageArtifactName('generated.png', 'image/avif'), /^generated-[\da-f-]+\.avif$/)
  assert.throws(() => imageArtifactName('cat', 'text/html'), /Unsupported/)
})

class ImageTestPrompt extends Service {
  constructor(ctx: Context) { super(ctx, 'systemPrompt') }
  tools() { return () => {} }
}

class ImageTestAttachments extends Service {
  constructor(ctx: Context) { super(ctx, 'attachments') }
  async saveFile({ data, name }: { data: Uint8Array; name: string }) {
    return { attachmentId: 'sha256:generated-image', name, bytes: data.length, storageMetadata: 'provider-only' }
  }
  fileHostPath({ name }: { name: string }) { return `/attachments/${name}` }
}

class ImageTestFs extends Service {
  constructor(ctx: Context) { super(ctx, 'fs') }
  processPathFromHostPath(path: string) { return `/execution${path}` }
}

test('real Cordis and tools runtime track late services, settings, teardown, and FileBlock projection', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(ImageTestPrompt).await()
    let enabled = true
    let binding!: ReturnType<typeof bindQoderImageTools>
    const transport = {
      searchImages: async () => ({ requestId: 'search-id', results: [] }),
      generateImage: async () => ({ bytes: new Uint8Array([1, 2, 3]), mediaType: 'image/png', requestId: 'generation-id', imageUrl: 'https://images.example/generated.png' }),
    } as unknown as QoderTransport
    const owner = ctx.plugin((ownerCtx: Context) => {
      binding = bindQoderImageTools(ownerCtx, {
        resolveTransport: () => transport,
        getImageSearchEnabled: () => true,
        getImageGenEnabled: () => enabled,
      })
    })
    await owner.await()
    // Optional services arrive after the provider has already loaded.
    await ctx.plugin(ToolRuntime).await()
    assert.deepEqual(ctx.tools.schemas().map(tool => tool.name), ['ImageSearch'])
    await ctx.plugin(ImageTestAttachments).await()
    assert.deepEqual(ctx.tools.schemas().map(tool => tool.name), ['ImageSearch'])
    const fsOwner = ctx.plugin(ImageTestFs)
    await fsOwner.await()
    assert.deepEqual(ctx.tools.schemas().map(tool => tool.name).sort(), ['ImageGen', 'ImageSearch'])
    enabled = false
    binding.refresh()
    assert.deepEqual(ctx.tools.schemas().map(tool => tool.name), ['ImageSearch'])
    const denied = await ctx.tools.execute({ name: 'ImageGen', arguments: { name: 'cat', prompt: 'cat' }, callId: ToolCallId('disabled'), signal: new AbortController().signal })
    assert.equal(denied.isError, true)
    enabled = true
    binding.refresh()
    const callId = ToolCallId('image-generation')
    const result = await ctx.tools.execute({ name: 'ImageGen', arguments: { name: 'cat', prompt: 'cat' }, callId, signal: new AbortController().signal })
    assert.equal(result.isError, false)
    assert.equal(result.content[1]?.type, 'file')
    if (result.content[1]?.type === 'file') {
      assert.deepEqual(Object.keys(result.content[1].attachment).sort(), ['attachmentId', 'bytes', 'name'])
    }

    // Exercise the real LLM's FileBlock-to-handle projection before Qoder's
    // text-only wire validator; generated files must not become vision input.
    let received: GenerateOptions | undefined
    let translated: unknown
    class CapturingAdapter extends LlmAdapter {
      async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        received = options
        translated = await validateAndTranslateMessages(options.messages)
        yield { type: 'text-delta', index: 0, text: 'accepted' }
      }
    }
    await ctx.plugin(LlmRuntime).await()
    ctx.llm.registerAdapter(['image-test'], new CapturingAdapter())
    const chunks = []
    for await (const chunk of ctx.llm.stream({
      provider: 'image-test', model: 'text-only',
      messages: [createToolResultMessage({ content: result.content, callId, isError: false })],
    })) chunks.push(chunk)
    assert.ok(received)
    assert.equal(received.messages[0]!.content.every(block => block.type === 'text'), true)
    assert.match(JSON.stringify(translated), /\/execution\/attachments\/cat-/)
    assert.deepEqual(chunks, [{ type: 'text-delta', index: 0, text: 'accepted' }])

    await fsOwner.dispose()
    assert.deepEqual(ctx.tools.schemas().map(tool => tool.name), ['ImageSearch'])
    await ctx.plugin(ImageTestFs).await()
    assert.equal(ctx.tools.schemas().length, 2)
    await owner.dispose()
    assert.equal(ctx.tools.schemas().length, 0)
    binding.refresh()
    assert.equal(ctx.tools.schemas().length, 0)
  } finally { await ctx.fiber.dispose() }
})

for (const missingCapability of ['saveFile', 'fileHostPath', 'processPathFromHostPath'] as const) {
  test(`image generation is omitted without ${missingCapability}`, () => {
    const f = fixture({ missingCapability })
    try {
      assert.equal(f.tools.has('ImageGen'), false)
      assert.equal(f.tools.has('ImageSearch'), true)
      assert.equal(f.calls.length, 0)
    } finally { f.dispose() }
  })
}
