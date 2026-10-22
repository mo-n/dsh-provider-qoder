import test from 'node:test'
import assert from 'node:assert/strict'
import { createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { Config } from '../src/dsh/config.ts'
import { QoderAuthService } from '../src/qoder/transport/auth.ts'
import { createQoderTransport } from '../src/qoder/transport/index.ts'
import { parseModelServerSse } from '../src/qoder/transport/wire/model-server-sse.ts'
import type { QoderMalformedFrameDetails } from '../src/qoder/transport/wire/stream-chunks.ts'
import { qoderIdeVersion } from '../src/qoder/transport/wire/client-identity.ts'

function request(): GenerateOptions {
  return {
    provider: 'dsh-provider-qoder',
    model: 'cmodel',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'Hello' }], source: { kind: 'user' } })],
  }
}

function sse(text: string): Response {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  })
}

async function collect(transport: ReturnType<typeof createQoderTransport>): Promise<string> {
  let content = ''
  for await (const chunk of transport.stream(request())) if (chunk.type === 'text-delta') content += chunk.text
  return content
}

test('existing settings select legacy and Bearer HTTP remains explicit', () => {
  assert.equal(Config({}).modelTransport, 'legacy')
  assert.equal(Config({ modelTransport: 'http' }).modelTransport, 'http')
  assert.throws(() => Config({ modelTransport: 'other' as 'http' }))
})

test('unspecified transport and compression use uncompressed legacy requests', async () => {
  let modelCalls = 0
  const transport = createQoderTransport({
    region: 'global',
    resolvePat: async () => 'pt-model',
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/jobToken/exchange')) return new Response(JSON.stringify({ token: 'jt-model', expires_in: 3600 }))
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'user-model' }))
      assert.match(url, /algo\/api\/v2\/service\/pro\/sse\/agent_chat_generation/u)
      modelCalls++
      const headers = new Headers(init?.headers)
      assert.equal(headers.get('content-encoding'), null)
      assert.ok(headers.get('cosy-key'))
      assert.equal(typeof init?.body, 'string')
      const body = JSON.stringify({ choices: [{ delta: { content: 'legacy response' }, finish_reason: 'stop' }] })
      return new Response(`data: ${JSON.stringify({ statusCodeValue: 200, body })}\n\ndata: [DONE]\n\n`)
    }) as typeof fetch,
  })
  let text = ''
  const largeRequest = request()
  largeRequest.messages = [createUserMessage({ content: [{ type: 'text', text: 'history '.repeat(2000) }], source: { kind: 'user' } })]
  for await (const chunk of transport.stream(largeRequest)) if (chunk.type === 'text-delta') text += chunk.text
  assert.equal(text, 'legacy response')
  assert.equal(modelCalls, 1)
})

test('explicit HTTP transport sends Bearer model-server request and reads direct SSE', async () => {
  let chatCalls = 0
  const debug: unknown[][] = []
  const transport = createQoderTransport({
    modelTransport: 'http',
    region: 'global',
    resolvePat: async () => 'pt-model',
    resolveMachineId: () => 'machine-test',
    logger: { debug: (...details) => debug.push(details) },
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/jobToken/exchange')) return new Response(JSON.stringify({ token: 'jt-model', expires_in: 3600 }))
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'user-model' }))
      assert.equal(url, 'https://api2-v2.qoder.sh/model/v1/chat/completions')
      chatCalls++
      const headers = init?.headers as Record<string, string>
      assert.equal(headers.Authorization, 'Bearer jt-model')
      assert.equal(headers['Cosy-Version'], qoderIdeVersion)
      assert.equal(headers['Cosy-ClientType'], '5')
      assert.match(headers['Cosy-MachineOS'], /^(?:x86_64|aarch64|[^_]+)_[a-z0-9]+$/u)
      if (headers['Cosy-MachineHostname']) assert.match(headers['Cosy-MachineHostname'], /^[\x20-\x7e]+$/u)
      assert.ok(!('Cosy-Key' in headers))
      assert.ok(!('Cosy-User' in headers))
      const body = JSON.parse(String(init?.body))
      assert.equal(body.model, 'cmodel')
      assert.equal(body.metadata.context.request_id, headers['X-Request-ID'])
      assert.ok(body.metadata.business.id)
      assert.equal(body.metadata.business.version, qoderIdeVersion)
      assert.ok(body.metadata.context.request_set_id)
      return sse('Bearer response')
    }) as typeof fetch,
  })
  assert.equal(await collect(transport), 'Bearer response')
  assert.equal(chatCalls, 1)
  assert.ok(!debug.some(entry => String(entry[0]).includes('capture')))
})

test('model-server HTTP 401 refreshes the rejected job token once and keeps request identity', async () => {
  let exchanges = 0
  const requestIds: string[] = []
  const transport = createQoderTransport({
    modelTransport: 'http',
    region: 'china',
    resolvePat: async () => 'pt-model',
    resolveMachineId: () => 'machine-test',
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/jobToken/exchange')) return new Response(JSON.stringify({ token: `jt-${++exchanges}`, expires_in: 3600 }))
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'user-model' }))
      assert.equal(url, 'https://gateway.qoder.com.cn/model/v1/chat/completions')
      const headers = init?.headers as Record<string, string>
      requestIds.push(headers['X-Request-ID'])
      return requestIds.length === 1 ? new Response('{}', { status: 401 }) : sse('Recovered')
    }) as typeof fetch,
  })
  assert.equal(await collect(transport), 'Recovered')
  assert.equal(exchanges, 2)
  assert.equal(requestIds.length, 2)
  assert.equal(requestIds[0], requestIds[1])
})

test('HTTP parsing completes or fails promptly when the upstream SSE connection stays open', async () => {
  for (const malformedTools of [false, true]) {
    const abort = new AbortController()
    const timeout = setTimeout(() => abort.abort(), 1000)
    let cancellations = 0
    const transport = createQoderTransport({
      modelTransport: 'http', region: 'global', resolvePat: async () => 'pt-model',
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.includes('/jobToken/exchange')) return Response.json({ token: 'jt-model', expires_in: 3600 })
        if (url.includes('/userinfo')) return Response.json({ id: 'user-model' })
        const delta = malformedTools
          ? { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'lookup', arguments: '{' } }] }
          : { content: 'finished' }
        let onAbort: () => void
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            onAbort = () => controller.error(new Error('caller deadline'))
            init?.signal?.addEventListener('abort', onAbort, { once: true })
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: malformedTools ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`))
            // Intentionally no close(): completion must cancel the actual response body.
          },
          cancel() {
            cancellations++
            init?.signal?.removeEventListener('abort', onAbort)
          },
        })
        return new Response(body)
      }) as typeof fetch,
    })
    const chunks: StreamChunk[] = []
    const consume = async () => {
      for await (const chunk of transport.stream({ ...request(), signal: abort.signal })) chunks.push(chunk)
    }
    try {
      if (malformedTools) await assert.rejects(consume, (error: Error & { code?: string }) => error.code === 'MALFORMED_RESPONSE')
      else {
        await consume()
        assert.ok(chunks.some(chunk => chunk.type === 'finish' && chunk.reason.kind === 'stop'))
      }
      assert.equal(abort.signal.aborted, false)
      assert.equal(cancellations, 1)
    } finally {
      clearTimeout(timeout)
      abort.abort()
    }
  }
})

test('HTTP turn identity is stable within a host run and isolated across runs and regions', async () => {
  let runId = 'run-a'
  const bodies: Array<{ metadata: { context: { request_id: string; request_set_id: string; session_id: string }; business: { id: string } } }> = []
  const create = (region: 'global' | 'china') => createQoderTransport({
    region, modelTransport: 'http', resolvePat: async () => 'pt-model',
    captureQueueLeaseOwner: () => ({ runId, retain: () => true }),
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/jobToken/exchange')) return Response.json({ token: 'jt-model', expires_in: 3600 })
      if (url.includes('/userinfo')) return Response.json({ id: 'user-model' })
      bodies.push(JSON.parse(String(init?.body)))
      return sse('ok')
    }) as typeof fetch,
  })
  const global = create('global')
  const consume = async (transport: ReturnType<typeof create>, purpose?: GenerateOptions['purpose']) => {
    for await (const _chunk of transport.stream({ ...request(), sessionId: 'http-run-scope' as GenerateOptions['sessionId'], purpose })) continue
  }
  await consume(global)
  await consume(global)
  await consume(global, 'session-title')
  await consume(global)
  runId = 'run-b'
  await consume(global)
  await consume(create('china'))
  const business = bodies.map(body => body.metadata.business.id)
  const requestSets = bodies.map(body => body.metadata.context.request_set_id)
  assert.equal(business[0], business[1])
  assert.equal(business[0], business[3])
  assert.notEqual(business[0], business[2])
  assert.notEqual(business[0], business[4])
  assert.notEqual(business[4], business[5])
  assert.equal(requestSets[0], requestSets[1])
  assert.notEqual(requestSets[0], requestSets[4])
  assert.notEqual(requestSets[4], requestSets[5])
  assert.equal(bodies[0].metadata.context.session_id, bodies[4].metadata.context.session_id)
  assert.equal(new Set(bodies.map(body => body.metadata.context.request_id)).size, bodies.length)
})

test('concurrent rejected credentials share one recovery exchange', async () => {
  let exchanges = 0
  const auth = new QoderAuthService({
    resolveMachineId: () => 'machine-test',
    fetch: (async (input: RequestInfo | URL) => {
      if (String(input).includes('/jobToken/exchange')) {
        await new Promise(resolve => setTimeout(resolve, 5))
        return new Response(JSON.stringify({ token: `jt-${++exchanges}`, expires_in: 3600 }))
      }
      return new Response(JSON.stringify({ id: 'user-model' }))
    }) as typeof fetch,
  })
  const rejected = await auth.getCredentials('pt-model')
  assert.ok(rejected.expiresAt > Date.now())
  const results = await Promise.all(Array.from({ length: 5 }, () => auth.refreshCredentials('pt-model', rejected)))
  assert.equal(exchanges, 2)
  assert.ok(results.every(result => result === results[0]))
  assert.ok(results[0].version > rejected.version)
  assert.equal(await auth.refreshCredentials('pt-model', rejected), results[0])
  assert.equal(exchanges, 2)
})

test('model-server business rejection does not refresh or enter legacy', async () => {
  let exchanges = 0
  let modelCalls = 0
  const transport = createQoderTransport({
    modelTransport: 'http',
    region: 'global',
    resolvePat: async () => 'pt-model',
    fetch: (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/jobToken/exchange')) {
        exchanges++
        return new Response(JSON.stringify({ token: 'jt-model', expires_in: 3600 }))
      }
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'user-model' }))
      assert.match(url, /model\/v1\/chat\/completions/u)
      modelCalls++
      return new Response(JSON.stringify({ error: { code: 103, message: 'duplicate request' } }), { status: 403 })
    }) as typeof fetch,
  })
  await assert.rejects(collect(transport), (error: Error & { code?: string }) => error.code === 'PROVIDER_ERROR')
  assert.equal(modelCalls, 1)
  assert.equal(exchanges, 1)
})

test('model-server stream authentication error is not replayed', async () => {
  let modelCalls = 0
  const transport = createQoderTransport({
    modelTransport: 'http',
    region: 'global',
    resolvePat: async () => 'pt-model',
    fetch: (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/jobToken/exchange')) return new Response(JSON.stringify({ token: 'jt-model', expires_in: 3600 }))
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'user-model' }))
      modelCalls++
      return new Response('data: {"error":{"code":105,"message":"expired"}}\n\n', { status: 200 })
    }) as typeof fetch,
  })
  await assert.rejects(collect(transport), (error: Error & { code?: string }) => error.code === 'AUTH')
  assert.equal(modelCalls, 1)
})

test('preflight refresh keeps a still-valid token after a temporary network error', async () => {
  let exchanges = 0
  const auth = new QoderAuthService({
    fetch: (async (input: RequestInfo | URL) => {
      if (String(input).includes('/jobToken/exchange')) {
        exchanges++
        if (exchanges === 2) throw new Error('temporary network failure')
        return new Response(JSON.stringify({ token: 'jt-valid', expires_in: 1 }))
      }
      return new Response(JSON.stringify({ id: 'user-model' }))
    }) as typeof fetch,
  })
  const first = await auth.getCredentials('pt-model')
  await new Promise(resolve => setTimeout(resolve, 850))
  const second = await auth.getCredentials('pt-model')
  assert.equal(second, first)
  assert.equal(exchanges, 2)
})

test('direct model-server SSE preserves reasoning, tool exchange and usage', async () => {
  const frames = [
    { choices: [{ delta: { reasoning_content: 'reason' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'lookup', arguments: '{"q":"x"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 3 } },
  ]
  const stream = new Response(`${frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('')}data: [DONE]\n\n`).body!
  const chunks = []
  for await (const chunk of parseModelServerSse(stream)) chunks.push(chunk)
  assert.ok(chunks.some(chunk => chunk.type === 'reasoning-delta'))
  assert.ok(chunks.some(chunk => chunk.type === 'tool-call-delta'))
  assert.ok(chunks.some(chunk => chunk.type === 'usage'))
  assert.ok(chunks.some(chunk => chunk.type === 'finish' && chunk.reason.kind === 'tool-calls'))
})

test('model-server ignores top-level success codes and known control frames', async () => {
  const lines = [
    'data: [NOT_EXCEED_QUOTA]',
    'data: [EXCEED_QUOTA]#{"remaining":0}',
    'data: [NOTIFICATIONS]#{"notifications":[{"type":"credit"}]}',
    'data: {"code":0}',
    'data: {"code":200}',
    'data: {"code":200,"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}',
    'data: [DONE]',
  ]
  const chunks = []
  const controls: string[] = []
  for await (const chunk of parseModelServerSse(new Response(`${lines.join('\n\n')}\n\n`).body!, {
    onControlFrame: kind => controls.push(kind),
  })) chunks.push(chunk)
  assert.equal(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), 'ok')
  assert.equal(chunks.at(-1)?.type, 'finish')
  assert.deepEqual(controls, ['quota-available', 'quota-exceeded', 'notifications', 'done'])
})

test('unknown model-server control frames remain protocol errors', async () => {
  const diagnostics: QoderMalformedFrameDetails[] = []
  await assert.rejects(async () => {
    for await (const _chunk of parseModelServerSse(new Response('data: [NEW_CONTROL]#{"secret":"private"}\n\n').body!, {
      onMalformedFrame: details => diagnostics.push(details),
    })) continue
  }, (error: Error & { code?: string }) => error.code === 'MALFORMED_RESPONSE')
  assert.equal(diagnostics[0]?.marker, '[NEW_CONTROL]')
  assert.equal(diagnostics[0]?.chars, 34)
  assert.equal(diagnostics[0]?.lines, 1)
  assert.equal(diagnostics[0]?.shape, 'array')
  assert.doesNotMatch(JSON.stringify(diagnostics), /private/u)
})

test('model-server assembles multiline SSE data before decoding JSON', async () => {
  const chunks = []
  const stream = new Response('event: message\n' +
    'data: {"choices":[{"delta":\n' +
    'data: {"content":"joined"},"finish_reason":"stop"}]}\n\n' +
    'data: [DONE]\n\n').body!
  for await (const chunk of parseModelServerSse(stream)) chunks.push(chunk)
  assert.equal(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), 'joined')
})

test('model-server preserves frames across every byte split including usage and UTF-8', async () => {
  const wire = new TextEncoder().encode(
    'data: {"choices":[{"delta":{"content":"你好🌍"}}]}\n\n' +
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
    'data: {"choices":[],"raw_usage":{"account_discount":0,"data":{"completion_tokens":21}},"usage":{"prompt_tokens":10,"completion_tokens":21}}\n\n' +
    'data: [DONE]\n\n',
  )
  for (let split = 1; split < wire.length; split++) {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(wire.slice(0, split))
        controller.enqueue(wire.slice(split))
        controller.close()
      },
    })
    const diagnostics: QoderMalformedFrameDetails[] = []
    const chunks = []
    for await (const chunk of parseModelServerSse(stream, {
      onMalformedFrame: details => diagnostics.push(details),
    })) chunks.push(chunk)
    assert.equal(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), '你好🌍')
    assert.ok(chunks.some(chunk => chunk.type === 'usage' && chunk.usage.outputTokens === 21))
    assert.deepEqual(diagnostics, [], `unexpected JSON failure at byte split ${split}`)
  }
})

test('model-server recovers unprefixed JSON continuations without losing tool argument deltas', async () => {
  const frame = JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-image',
    function: { name: 'read_image', arguments: '{"file_path":"a.png"}' } }] } }], model: 'dfmodel' })
  // Exercise inserted newlines throughout JSON, including escaped quotes and model metadata.
  for (let split = 1; split < frame.length; split++) {
    const wire = new TextEncoder().encode(`data: ${frame.slice(0, split)}\r\n${frame.slice(split)}\r\n\r\ndata: [DONE]\n\n`)
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      for (let offset = 0; offset < wire.length; offset += 7) controller.enqueue(wire.slice(offset, offset + 7))
      controller.close()
    } })
    const chunks = []
    const diagnostics: QoderMalformedFrameDetails[] = []
    for await (const chunk of parseModelServerSse(stream, {
      onMalformedFrame: details => diagnostics.push(details),
    })) chunks.push(chunk)
    const call = chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
    assert.ok(call?.type === 'block-end' && call.block.type === 'tool-call')
    assert.equal(call.block.arguments, '{"file_path":"a.png"}', `split ${split}`)
    assert.equal(diagnostics[0]?.disposition, 'recovered-continuation')
  }
})

test('model-server prefers standard SSE data and excludes fields and comments from recovery', async () => {
  const wires = [
    'data: {"choices":[\ndata: {"delta":{"content":"ok\\nnext"},"finish_reason":"stop"}]}\nignored continuation\n\n',
    'data: {"choices":[{"delta":{"content":"o\n: heartbeat\nid: event-id\nretry: 1000\ncustom: ignored\nk"},"finish_reason":"stop"}]}\n\n',
  ]
  for (const [index, wire] of wires.entries()) {
    const chunks = []
    const diagnostics: QoderMalformedFrameDetails[] = []
    for await (const chunk of parseModelServerSse(new Response(wire).body!, {
      onMalformedFrame: details => diagnostics.push(details),
    })) chunks.push(chunk)
    assert.equal(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), index ? 'ok' : 'ok\nnext')
    assert.equal(diagnostics.length, index ? 1 : 0)
  }
})

test('model-server recovers a newline before the created property separator', async () => {
  const chunks = []
  for await (const chunk of parseModelServerSse(new Response(
    'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}],"created"\n:1792486219}\n\n',
  ).body!)) chunks.push(chunk)
  assert.equal(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), 'ok')
})

test('model-server never recovers across events or ignores invalid recovered payloads', async () => {
  for (const wire of [
    'data: {"choices":[\n\n{"delta":{"content":"lost"}}]}\n\ndata: [DONE]\n\n',
    'data: {"choices":[\nnot JSON\n\ndata: [DONE]\n\n',
    'data: {"choices":[\ndata: {"delta":{"content":"split\ndata: string"}}]}\n\ndata: [DONE]\n\n',
  ]) {
    await assert.rejects(async () => {
      for await (const _chunk of parseModelServerSse(new Response(wire).body!)) continue
    }, (error: Error & { code?: string }) => error.code === 'MALFORMED_RESPONSE')
  }
  await assert.rejects(async () => {
    const wire = 'data: {"choices":[\n' + 'x'.repeat(100) + '\n\n'
    for await (const _chunk of parseModelServerSse(new Response(wire).body!, { maxBufferChars: 60 })) continue
  }, /size limit/)
})

test('model-server rejects an unfinished stream after a truncated frame', async () => {
  for (const terminator of ['', '\n\n']) {
    const diagnostics: QoderMalformedFrameDetails[] = []
    await assert.rejects(async () => {
      const stream = new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n' +
        'data: {"choices":[{"delta":{"content":"cut' + terminator).body!
      for await (const _chunk of parseModelServerSse(stream, {
        onMalformedFrame: details => diagnostics.push(details),
      })) continue
    }, (error: Error & { code?: string }) => error.code === (terminator ? 'MALFORMED_RESPONSE' : 'TRANSPORT'))
    assert.equal(diagnostics[0]?.atEof, !terminator)
    assert.equal(diagnostics[0]?.afterFinish, false)
    assert.equal(diagnostics[0]?.syntax, 'truncated')
    assert.equal(diagnostics[0]?.emptyChoicesPrefix, false)
    assert.equal(diagnostics[0]?.disposition, 'rejected')
  }
})

test('model-server rejects a truncated content frame even when a later event finishes', async () => {
  const diagnostics: QoderMalformedFrameDetails[] = []
  const stream = new Response(
    'data: {"choices":[{"delta":{"content":"","reasoning_content":"partial reasoning"},"finish_reason":null,"index":0}],"created":1792484887,"model":"qfmodel",\n\n' +
    'data: {"choices":[{"delta":{"content":"answer"},"finish_reason":"stop","index":0}]}\n\n',
  ).body!
  await assert.rejects(async () => {
    for await (const _chunk of parseModelServerSse(stream, {
      onMalformedFrame: details => diagnostics.push(details),
    })) continue
  }, (error: Error & { code?: string }) => error.code === 'MALFORMED_RESPONSE')
  assert.equal(diagnostics.length, 1)
  assert.equal(diagnostics[0]?.afterFinish, false)
  assert.equal(diagnostics[0]?.emptyChoicesPrefix, false)
  assert.equal(diagnostics[0]?.disposition, 'rejected')
})

test('model-server rejects a truncated frame before consuming a later error event', async () => {
  await assert.rejects(async () => {
    const stream = new Response('data: {"choices":[{"delta":{"content":"lost"}}],\n\n' +
      'event: error\ndata: {"code":105,"message":"expired"}\n\n').body!
    for await (const _chunk of parseModelServerSse(stream)) continue
  }, (error: Error & { code?: string }) => error.code === 'MALFORMED_RESPONSE')
})

test('model-server waits for independent completion after a truncated empty-choices metadata frame', async () => {
  const partial = 'data: {"choices":[{"delta":{"content":"answer"}}]}\n\n' +
    'data: {"choices":[],"created":179248\n\n'
  const diagnostics: QoderMalformedFrameDetails[] = []
  const chunks = []
  for await (const chunk of parseModelServerSse(new Response(partial + 'data: [DONE]\n\n').body!, {
    onMalformedFrame: details => diagnostics.push(details),
  })) chunks.push(chunk)
  assert.equal(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), 'answer')
  assert.equal(chunks.at(-1)?.type, 'finish')
  assert.equal(diagnostics[0]?.emptyChoicesPrefix, true)
  assert.equal(diagnostics[0]?.disposition, 'skipped-auxiliary')
  await assert.rejects(async () => {
    for await (const _chunk of parseModelServerSse(new Response(partial).body!)) continue
  }, (error: Error & { code?: string }) => error.code === 'TRANSPORT')
})

test('model-server classifies a plain-text SSE error event without exposing its payload', async () => {
  const diagnostics: unknown[] = []
  await assert.rejects(async () => {
    for await (const _chunk of parseModelServerSse(new Response('event: error\ndata: provider private details\n\n').body!, {
      onMalformedFrame: details => diagnostics.push(details),
    })) continue
  }, (error: Error & { code?: string }) => error.code === 'PROVIDER_ERROR'
    && !error.message.includes('private details'))
  assert.equal((diagnostics[0] as Record<string, unknown>)?.eventType, 'error')
  assert.equal((diagnostics[0] as Record<string, unknown>)?.chars, 24)
  assert.equal((diagnostics[0] as Record<string, unknown>)?.lines, 1)
})

test('model-server preserves the upstream code from a JSON SSE error event', async () => {
  await assert.rejects(async () => {
    for await (const _chunk of parseModelServerSse(new Response('event: error\ndata: {"code":105,"message":"expired"}\n\n').body!)) continue
  }, (error: Error & { code?: string; upstreamCode?: string }) => error.code === 'AUTH' && error.upstreamCode === '105')
})

test('model-server ignores a truncated raw_usage trailer after a terminal finish reason', async () => {
  for (const ending of ['', 'data: [DONE]\n\n']) {
    const diagnostics: QoderMalformedFrameDetails[] = []
    const stream = new Response('data: {"choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}]}\n\n' +
      'data: {"choices":[],"raw_usage":{"completion_tokens\n\n' + ending).body!
    const chunks = []
    for await (const chunk of parseModelServerSse(stream, {
      onMalformedFrame: details => diagnostics.push(details),
    })) chunks.push(chunk)
    assert.equal(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), 'answer')
    assert.equal(chunks.at(-1)?.type, 'finish')
    assert.equal(diagnostics.length, 1)
    assert.equal(diagnostics[0]?.shape, 'object')
    assert.equal(diagnostics[0]?.syntax, 'truncated')
    assert.equal(diagnostics[0]?.emptyChoicesPrefix, true)
    assert.equal(diagnostics[0]?.disposition, 'skipped-after-finish')
  }
})

test('model-server does not ignore a valid JSON value with an invalid shape after finish', async () => {
  await assert.rejects(async () => {
    for await (const _chunk of parseModelServerSse(new Response(
      'data: {"choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}]}\n\n' +
      'data: null\n\n',
    ).body!)) continue
  }, (error: Error & { code?: string }) => error.code === 'MALFORMED_RESPONSE')
})

test('model-server records response timing and request ID without logging credentials', async () => {
  const entries: Array<{ message: string; details: unknown[] }> = []
  const warnings: Array<{ message: string; details: unknown[] }> = []
  const transport = createQoderTransport({
    modelTransport: 'http',
    region: 'global',
    resolvePat: async () => 'pt-model',
    logger: {
      debug: (message, ...details) => entries.push({ message, details }),
      warn: (message, ...details) => warnings.push({ message, details }),
    },
    fetch: (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/jobToken/exchange')) return new Response(JSON.stringify({ token: 'jt-model', expires_in: 3600 }))
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'user-model' }))
      return new Response('data: [NOTIFICATIONS]#{"notifications":[{"message":"private notice"}]}\n\ndata: {"choices":[{"delta":{"content":"logged"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
        headers: { 'x-request-id': 'upstream-request' },
      })
    }) as typeof fetch,
  })
  assert.equal(await collect(transport), 'logged')
  const responseEntry = entries.find(entry => entry.message === '[Qoder Stream] Response headers received')
  const responseDetails = responseEntry?.details[0] as Record<string, unknown> | undefined
  assert.equal(responseDetails?.region, 'global')
  assert.equal(responseDetails?.transport, 'http')
  assert.equal(responseDetails?.status, 200)
  assert.equal(responseDetails?.attempt, 1)
  assert.equal(responseDetails?.requestId, 'upstream-request')
  assert.equal(typeof responseDetails?.durationMs, 'number')
  assert.ok(entries.some(entry => entry.message === '[Qoder Stream] First chunk received'))
  assert.ok(entries.some(entry => entry.message === '[Qoder Stream] Stream completed'))
  assert.deepEqual(warnings.filter(entry => entry.message === '[Qoder Stream] Control frame skipped')
    .map(entry => (entry.details[0] as { kind: string }).kind), ['notifications'])
  assert.doesNotMatch(JSON.stringify([entries, warnings]), /private notice|pt-model|jt-model/u)
})

test('model-server logs only structural diagnostics after a streamed frame fails to decode', async () => {
  const warnings: unknown[][] = []
  const transport = createQoderTransport({
    modelTransport: 'http',
    region: 'global',
    resolvePat: async () => 'pt-model',
    logger: { warn: (...details) => warnings.push(details) },
    fetch: (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/jobToken/exchange')) return new Response(JSON.stringify({ token: 'jt-model', expires_in: 3600 }))
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'user-model' }))
      return new Response('data: {"choices":[{"delta":{"content":"first"}}]}\n\n' +
        'event: message\ndata: [NEW_CONTROL]#{"secret":"private"}\n\n', {
        headers: { 'x-request-id': 'upstream-request' },
      })
    }) as typeof fetch,
  })
  await assert.rejects(collect(transport), (error: Error & { code?: string }) => error.code === 'MALFORMED_RESPONSE')
  const diagnostic = warnings.find(entry => entry[0] === '[Qoder Stream] Malformed SSE frame')?.[1] as Record<string, unknown>
  assert.equal(diagnostic?.marker, '[NEW_CONTROL]')
  assert.equal(diagnostic?.eventType, 'message')
  assert.equal(diagnostic?.requestId, 'upstream-request')
  assert.equal(diagnostic?.rawFrame, undefined)
  assert.doesNotMatch(JSON.stringify(warnings), /private|pt-model|jt-model/u)
})

test('failed tool-call parsing does not capture model requests or responses', async () => {
  const warnings: unknown[][] = []
  const rawResponse = 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"read_image","arguments":"{\\"path\\":"}}]},"finish_reason":"tool_calls"}]}\n\n' +
    'data: [DONE]\n\n'
  const transport = createQoderTransport({
    modelTransport: 'http',
    region: 'global',
    resolvePat: async () => 'pt-model',
    logger: { warn: (...details) => warnings.push(details) },
    fetch: (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/jobToken/exchange')) return new Response(JSON.stringify({ token: 'jt-model', expires_in: 3600 }))
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'user-model' }))
      return new Response(rawResponse, { headers: { 'content-type': 'text/event-stream' } })
    }) as typeof fetch,
  })
  await assert.rejects(collect(transport), (error: Error & { code?: string }) => error.code === 'MALFORMED_RESPONSE')
  assert.ok(!warnings.some(entry => String(entry[0]).includes('capture')))
  assert.doesNotMatch(JSON.stringify(warnings), /read_image|jt-model|pt-model/u)
})

test('invalidating credentials prevents an old exchange from repopulating the cache', async () => {
  let exchanges = 0
  let releaseFirst: (() => void) | undefined
  const firstStarted = new Promise<void>(resolve => { releaseFirst = resolve })
  const auth = new QoderAuthService({
    fetch: (async (input: RequestInfo | URL) => {
      if (String(input).includes('/jobToken/exchange')) {
        exchanges++
        if (exchanges === 1) await firstStarted
        return new Response(JSON.stringify({ token: `jt-${exchanges}`, expires_in: 3600 }))
      }
      return new Response(JSON.stringify({ id: 'user-model' }))
    }) as typeof fetch,
  })
  const obsolete = auth.getCredentials('pt-model')
  await new Promise(resolve => setTimeout(resolve, 0))
  auth.clear('pt-model')
  const current = await auth.getCredentials('pt-model')
  releaseFirst?.()
  await assert.rejects(obsolete)
  assert.equal(current.authToken, 'jt-2')
  assert.equal((await auth.getCredentials('pt-model')).authToken, 'jt-2')
})
