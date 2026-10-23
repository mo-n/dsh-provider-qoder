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
