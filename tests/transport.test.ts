import test from 'node:test'
import assert from 'node:assert/strict'
import { createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { QoderLlmError } from '../src/errors.ts'
import { createQoderTransport } from '../src/transport.ts'

const catalog = JSON.stringify({ chat: [{ key: 'cmodel', enable: true, display_name: 'Cantus' }] })

test('QoderTransport shares concurrent model discovery', async () => {
  let catalogCalls = 0
  const transport = createQoderTransport({
    region: 'global',
    resolvePat: () => Promise.resolve('pt-shared'),
    resolveMachineId: () => 'machine-test',
    fetch: (async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input)
      if (url.includes('/jobToken/exchange')) return new Response(JSON.stringify({ token: 'jt-shared' }))
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'user-shared' }))
      if (url.includes('/model/list')) {
        catalogCalls++
        await new Promise(resolve => setTimeout(resolve, 5))
        return new Response(catalog)
      }
      throw new Error(`unexpected URL: ${url}`)
    }) as typeof fetch,
  })

  const [first, second] = await Promise.all([
    transport.discoverModels(),
    transport.discoverModels(),
  ])
  assert.equal(catalogCalls, 1)
  assert.equal(first, second)
})

test('QoderTransport retries an idempotent model discovery once', async () => {
  let catalogCalls = 0
  const transport = createQoderTransport({
    region: 'global',
    resolvePat: () => Promise.resolve('pt-retry'),
    resolveMachineId: () => 'machine-test',
    fetch: (async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input)
      if (url.includes('/jobToken/exchange')) return new Response(JSON.stringify({ token: 'jt-retry' }))
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'user-retry' }))
      if (url.includes('/model/list')) {
        catalogCalls++
        return catalogCalls === 1 ? new Response('', { status: 503 }) : new Response(catalog)
      }
      throw new Error(`unexpected URL: ${url}`)
    }) as typeof fetch,
  })

  const models = await transport.discoverModels()
  assert.equal(catalogCalls, 2)
  assert.equal(models[0]?.id, 'cmodel')
})

test('QoderTransport aborts a shared discovery only after its last waiter leaves', async () => {
  let stallCatalog = false
  let upstreamAborted = false
  let notifyStarted: (() => void) | undefined
  const started = new Promise<void>(resolve => { notifyStarted = resolve })
  const transport = createQoderTransport({
    region: 'global',
    resolvePat: () => Promise.resolve('pt-shared'),
    resolveMachineId: () => 'machine-test',
    fetch: (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      if (url.includes('/jobToken/exchange')) return new Response(JSON.stringify({ token: 'jt-shared' }))
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'user-shared' }))
      if (url.includes('/model/list') && !stallCatalog) return new Response(catalog)
      if (url.includes('/model/list')) {
        notifyStarted?.()
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            upstreamAborted = true
            reject(new DOMException('aborted', 'AbortError'))
          }, { once: true })
        })
      }
      throw new Error(`unexpected URL: ${url}`)
    }) as typeof fetch,
  })

  await transport.discoverModels()
  stallCatalog = true
  const firstController = new AbortController()
  const secondController = new AbortController()
  const first = transport.discoverModels(firstController.signal)
  const second = transport.discoverModels(secondController.signal)
  await started

  firstController.abort()
  await assert.rejects(first, (error: Error) => error instanceof QoderLlmError && error.code === 'ABORTED')
  assert.equal(upstreamAborted, false)

  secondController.abort()
  await assert.rejects(second, (error: Error) => error instanceof QoderLlmError && error.code === 'ABORTED')
  assert.equal(upstreamAborted, true)
})

test('QoderTransport separates response-header timeout from stream idle timeout', async () => {
  const transport = createQoderTransport({
    region: 'global',
    resolvePat: () => Promise.resolve('pt-timeout'),
    resolveMachineId: () => 'machine-test',
    responseHeaderTimeoutMs: 5,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      if (url.includes('/jobToken/exchange')) return new Response(JSON.stringify({ token: 'jt-timeout' }))
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'user-timeout' }))
      if (url.includes('/agent_chat_generation')) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('timeout', 'AbortError')), { once: true })
        })
      }
      throw new Error(`unexpected URL: ${url}`)
    }) as typeof fetch,
  })
  const request: GenerateOptions = {
    provider: 'qoder-official',
    model: 'cmodel',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'Hello' }], source: { kind: 'user' } })],
  }

  await assert.rejects(async () => {
    for await (const _chunk of transport.stream(request)) continue
  }, (error: Error) => (
    error instanceof QoderLlmError
    && error.code === 'TIMEOUT'
    && /response header/u.test(error.message)
  ))
})
