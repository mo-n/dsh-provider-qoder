import test from 'node:test'
import assert from 'node:assert/strict'
import { createQoderTransport, type QoderTransport } from '../src/qoder/transport/index.ts'
import { QoderModelCatalogEditor } from '../src/client/model-catalog-editor.ts'
import { QoderCatalogLifecycle } from '../src/dsh/catalog-lifecycle.ts'
import { QoderAdapter } from '../src/dsh/adapter.ts'
import { QoderTransportRuntime } from '../src/dsh/transport-runtime.ts'
import { registerQoderRpc } from '../src/dsh/rpc.ts'
import { parseModelServerSse } from '../src/qoder/transport/wire/model-server-sse.ts'
import { parseQoderSse } from '../src/qoder/transport/wire/sse.ts'
import { validateAndTranslateMessages } from '../src/qoder/transport/wire/translate.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve))

test('account waiters share credential recovery, including when the first caller cancels', async () => {
  for (const cancelFirst of [false, true]) {
    const started = deferred<void>(), release = deferred<void>()
    let token = 'old', refreshes = 0, reads = 0
    const transport = createQoderTransport({ region: 'global', resolvePat: async () => '',
      resolveCredential: async () => ({ key: 'account', resolve: async (_signal, rejected) => {
        if (rejected) { token = 'new'; refreshes++ }
        return { userID: 'test', authToken: token, name: 'Test', email: '', machineID: 'machine' }
      } }),
      fetch: async input => {
        if (String(input).includes('/quota/usage')) {
          reads++
          if (reads === 1) { started.resolve(); await release.promise; return new Response('', { status: 401 }) }
        }
        return Response.json({})
      },
    })
    const controller = new AbortController()
    const first = transport.readAccount({ signal: controller.signal })
    const second = transport.readAccount()
    const results = Promise.allSettled([first, second])
    await started.promise
    if (cancelFirst) controller.abort()
    release.resolve()
    const settled = await results
    assert.equal(settled[0].status, cancelFirst ? 'rejected' : 'fulfilled')
    assert.equal(settled[1].status, 'fulfilled')
    assert.equal(refreshes, 1)
    assert.equal(reads, 2)
  }
})

test('external accepted models remain visible after local catalog editing', async () => {
  const a = { id: 'a', name: 'A' }, b = { id: 'b', name: 'B' }, c = { id: 'c', name: 'C' }
  const editor = new QoderModelCatalogEditor('global', [a, b], {
    storeModels: async () => true, discoverModels: async () => ({ ok: true, value: [a, b] }),
  })
  await editor.toggle('b', false)
  editor.replaceModels([a, c])
  assert.deepEqual(editor.getSnapshot().models.map(model => model.id), ['a', 'c'])
  assert.deepEqual(editor.getSnapshot().catalog.map(model => model.id), ['a', 'b', 'c'])
})

test('credential preview cannot overwrite, persist, or supersede active discovery', async () => {
  const activeRead = deferred<Array<{ id: string; name: string; priceFactor: number }>>()
  const active = { discoverModels: () => activeRead.promise } as unknown as QoderTransport
  const preview = { discoverModels: async () => [{ id: 'a', name: 'A', priceFactor: 9 }] } as unknown as QoderTransport
  const writes: number[] = []
  let saved = [{ id: 'a', name: 'A', priceFactor: 0 }]
  const catalog = new QoderCatalogLifecycle({ resolveTransport: () => active, region: () => 'global', configuredModels: () => saved })
  catalog.bindSettings({ read: () => ({ models: saved, revision: 0 }), write: async (_region, models) => {
    writes.push(models[0].priceFactor!); saved = models.map(model => ({ id: model.id, name: model.name, priceFactor: model.priceFactor! }))
  } })
  const pending = catalog.discover()
  assert.equal((await catalog.discover(undefined, preview))[0].priceFactor, 9)
  assert.equal(catalog.models()[0].priceFactor, 0)
  assert.deepEqual(writes, [])
  activeRead.resolve([{ id: 'a', name: 'A', priceFactor: 1 }])
  await pending; await tick()
  assert.equal(catalog.models()[0].priceFactor, 1)
  assert.deepEqual(writes, [1])
  catalog.dispose()
})

test('partial RPC registration rolls back successful routes in reverse order', () => {
  const routes = new Set<string>(), removed: string[] = []
  let count = 0
  const ctx = { connection: { fetch: { register(route: { path: string }) {
    if (++count === 3) throw new Error('route conflict')
    routes.add(route.path)
    return () => { routes.delete(route.path); removed.push(route.path) }
  } } } } as unknown as Context
  assert.throws(() => registerQoderRpc(ctx, async () => ({ ok: true, value: {} })), /route conflict/)
  assert.equal(routes.size, 0)
  assert.deepEqual(removed, ['/api/qoder-subscription/models', '/api/qoder-subscription/account'])
})

for (const legacy of [false, true]) {
  test(`SSE event limits do not depend on network chunk boundaries (${legacy})`, async () => {
    const payload = { choices: [{ delta: { content: 'hello' } }] }
    const frame = 'data: ' + JSON.stringify(legacy ? { body: JSON.stringify(payload) } : payload) + '\n\n'
    const frames = [...Array<string>(10).fill(frame), 'data: [DONE]\n\n']
    const parse = legacy ? parseQoderSse : parseModelServerSse
    const collect = async (parts: string[]) => {
      const stream = new ReadableStream<Uint8Array>({ start(controller) {
        for (const part of parts) controller.enqueue(new TextEncoder().encode(part))
        controller.close()
      } })
      const chunks = []
      for await (const chunk of parse(stream, { maxBufferChars: 150 })) chunks.push(chunk)
      return chunks
    }
    assert.deepEqual(await collect([frames.join('')]), await collect(frames))
    assert.deepEqual(await collect([...frames.join('')]), await collect(frames))
    await assert.rejects(collect(['data: ' + 'x'.repeat(151)]), { code: 'MALFORMED_RESPONSE' })
  })
}

test('invalid later message is rejected before any credential or attachment I/O', async () => {
  let calls = 0
  const transport = createQoderTransport({ region: 'global', resolvePat: async () => { calls++; return 'test' },
    fetch: async () => { calls++; throw new Error('No network allowed') } })
  const image = { type: 'image', attachment: { width: 1, height: 1, bytes: 1 } }
  const options = { model: 'vision', messages: [{ role: 'user', content: [image] }, { role: 'assistant', content: [image] }] } as unknown as GenerateOptions
  await assert.rejects(async () => {
    for await (const _chunk of transport.stream(options, { id: 'vision', name: 'Vision', supportsImages: true })) continue
  }, { code: 'UNSUPPORTED_CONTENT' })
  assert.equal(calls, 0)
})

test('SSE payload limits accept exact-size frames at every split and reject oversized payloads', async () => {
  for (const legacy of [false, true]) {
    const payload = { choices: [{ delta: { content: 'ok' } }] }
    const json = JSON.stringify(legacy ? { body: JSON.stringify(payload) } : payload)
    for (const lines of [[json], ['{', json.slice(1)]]) {
      const limit = lines.reduce((size, line) => size + line.length + 1, 0)
      for (const newline of ['\n', '\r\n']) {
        for (const prefix of ['data:', 'data: ']) {
          const wire = lines.map(line => prefix + line + newline).join('') + newline + 'data: [DONE]' + newline + newline
          const collect = async (parts: string[], maxBufferChars = limit) => {
            const stream = new ReadableStream<Uint8Array>({ start(controller) {
              for (const part of parts) controller.enqueue(new TextEncoder().encode(part))
              controller.close()
            } })
            const chunks = []
            for await (const chunk of (legacy ? parseQoderSse : parseModelServerSse)(stream, { maxBufferChars })) chunks.push(chunk)
            return chunks
          }
          const expected = await collect([wire])
          assert.equal(expected.some(chunk => chunk.type === 'text-delta' && chunk.text === 'ok'), true)
          for (let split = 1; split < wire.length; split++) {
            assert.deepEqual(await collect([wire.slice(0, split), wire.slice(split)]), expected)
          }
          assert.deepEqual(await collect([...wire]), expected)
          for (const parts of [[wire], [...wire], [wire.slice(0, wire.indexOf(newline + newline))]]) {
            await assert.rejects(collect(parts, limit - 1), { code: 'MALFORMED_RESPONSE' })
          }
        }
      }
    }
  }
})

test('invalid tool-call roles and non-string text fail before credential or network I/O', async () => {
  const toolCall = { type: 'tool-call', id: 'call-test', name: 'lookup', arguments: '{}' }
  const invalid: Array<{ role: string; content: unknown[] }> = ['user', 'system', 'tool'].map(role => ({ role, content: [toolCall] }))
  for (const text of [undefined, null, 123, {}, []]) {
    for (const role of ['user', 'system', 'assistant', 'tool']) {
      invalid.push({ role, content: [{ type: 'text', text }] })
    }
    invalid.push({ role: 'assistant', content: [{ type: 'reasoning', text }] })
    invalid.push({ role: 'user', content: [{ type: 'tool-result', toolCallId: 'call-test', content: [{ type: 'text', text }] }] })
  }
  let calls = 0
  const transport = createQoderTransport({ region: 'global', resolvePat: async () => { calls++; return 'test' },
    fetch: async () => { calls++; throw new Error('No network allowed') } })
  for (const message of invalid) {
    const options = { model: 'test', messages: [message] } as unknown as GenerateOptions
    await assert.rejects(async () => {
      for await (const _chunk of transport.stream(options, { id: 'test', name: 'Test' })) continue
    }, { code: 'UNSUPPORTED_CONTENT' })
    await assert.rejects(validateAndTranslateMessages(options.messages), { code: 'UNSUPPORTED_CONTENT' })
  }
  assert.equal(calls, 0)
  const messages = [{ role: 'assistant', content: [toolCall] }, { role: 'user', content: [{ type: 'text', text: '' }] }]
  const translated = await validateAndTranslateMessages(messages as unknown as GenerateOptions['messages'])
  assert.equal(translated[0].tool_calls?.[0].function.name, 'lookup')
  assert.equal(translated[1].content, '')
})

test('session cleanup releases all regions without changing another session selection', () => {
  let region: 'global' | 'china' = 'global'
  const adapter = new QoderAdapter({ resolveTransport: () => ({}) as QoderTransport, region: () => region,
    models: [{ id: 'a', name: 'A', contextOptions: { small: { tokenCount: 100 }, large: { tokenCount: 200 } } }] })
  adapter.setSessionTier('gone', 'a', 'large')
  adapter.setSessionTier('kept', 'a', 'large')
  region = 'china'; adapter.setSessionTier('gone', 'a', 'small')
  adapter.forgetSession('gone')
  assert.equal(adapter.getSessionTier('gone', 'a'), undefined)
  region = 'global'
  assert.equal(adapter.getSessionTier('gone', 'a'), undefined)
  assert.equal(adapter.getSessionTier('kept', 'a'), 'large')
})

test('transport runtime replaces changed configuration atomically and retains captured instances', () => {
  let creations = 0
  const runtime = new QoderTransportRuntime({}, () => { creations++; return {} as unknown as QoderTransport })
  const captured = runtime.transport
  assert.equal(runtime.update({ webSearchMode: 'disabled' }), false)
  assert.equal(runtime.update({ region: 'china' }), true)
  assert.notEqual(runtime.transport, captured)
  assert.equal(runtime.config.region, 'china')
  const replaced = runtime.transport
  assert.equal(runtime.update({ region: 'china' }, true), true)
  assert.notEqual(runtime.transport, replaced)
  assert.equal(creations, 3)
})

test('every transport configuration field replaces the instance, and failed creation preserves the snapshot', () => {
  const changes = [
    { region: 'china' as const }, { streamIdleTimeoutMs: 1234 }, { responseHeaderTimeoutMs: 1234 },
    { modelQueueMaxWaitMs: 1234 }, { preserveThinking: false }, { requestCompression: true },
    { modelTransport: 'http' as const },
  ]
  for (const change of changes) {
    const runtime = new QoderTransportRuntime({}, () => ({}) as QoderTransport)
    const previous = runtime.transport
    assert.equal(runtime.update(change), true)
    assert.notEqual(runtime.transport, previous)
    assert.equal(runtime.update(change), false)
  }
  const runtime = new QoderTransportRuntime({}, config => {
    if (config.region === 'china') throw new Error('construction failed')
    return {} as QoderTransport
  })
  const previous = runtime.transport
  assert.throws(() => runtime.update({ region: 'china' }), /construction failed/)
  assert.equal(runtime.transport, previous)
  assert.equal(runtime.config.region, 'global')
})
