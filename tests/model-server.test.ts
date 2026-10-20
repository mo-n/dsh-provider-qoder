import test from 'node:test'
import assert from 'node:assert/strict'
import { createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { Config } from '../src/dsh/config.ts'
import { QoderAuthService } from '../src/qoder/transport/auth.ts'
import { createQoderTransport } from '../src/qoder/transport/index.ts'
import { parseModelServerSse } from '../src/qoder/transport/wire/model-server-sse.ts'
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

test('existing settings select Bearer HTTP and legacy remains explicit', () => {
  assert.equal(Config({}).modelTransport, 'http')
  assert.equal(Config({ modelTransport: 'legacy' }).modelTransport, 'legacy')
  assert.throws(() => Config({ modelTransport: 'other' as 'http' }))
})

test('default transport sends Bearer model-server request and reads direct SSE', async () => {
  let chatCalls = 0
  const transport = createQoderTransport({
    region: 'global',
    resolvePat: async () => 'pt-model',
    resolveMachineId: () => 'machine-test',
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/jobToken/exchange')) return new Response(JSON.stringify({ token: 'jt-model', expires_in: 3600 }))
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'user-model' }))
      assert.equal(url, 'https://api2-v2.qoder.sh/model/v1/chat/completions')
      chatCalls++
      const headers = init?.headers as Record<string, string>
      assert.equal(headers.Authorization, 'Bearer jt-model')
      assert.ok(!Object.keys(headers).some(key => key.toLowerCase().startsWith('cosy-')))
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
})

test('model-server HTTP 401 refreshes the rejected job token once and keeps request identity', async () => {
  let exchanges = 0
  const requestIds: string[] = []
  const transport = createQoderTransport({
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
  await assert.rejects(async () => {
    for await (const _chunk of parseModelServerSse(new Response('data: [NEW_CONTROL]#{}\n\n').body!)) continue
  }, (error: Error & { code?: string }) => error.code === 'MALFORMED_RESPONSE')
})

test('model-server records response timing and request ID without logging credentials', async () => {
  const entries: Array<{ message: string; details: unknown[] }> = []
  const warnings: Array<{ message: string; details: unknown[] }> = []
  const transport = createQoderTransport({
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
