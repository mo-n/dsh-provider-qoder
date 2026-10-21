import test from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate, setTimeout as delay } from 'node:timers/promises'
import { resolveRetryPolicy, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { QoderLlmError } from '../src/qoder/errors.ts'
import { streamQoderChat, type QoderChatDependencies } from '../src/qoder/transport/chat.ts'
import { ModelQueue, queueFailure, queueInterval, type ModelQueueOptions, type QueueClock } from '../src/qoder/transport/queue.ts'
import { queuedError, parseQueueStatus } from '../src/qoder/transport/wire/queue.ts'
import { buildQoderRequestBody } from '../src/qoder/transport/wire/serialize.ts'
import type { CosyCredentials } from '../src/qoder/transport/wire/cosy.ts'
import type { QoderWireRequest } from '../src/qoder/transport/wire/wire-types.ts'
import type { QoderQueueUpdate } from '../src/qoder/queue.ts'
import { QoderQueueLeases } from '../src/dsh/queue-leases.ts'
import { createQoderTransport } from '../src/qoder/transport/index.ts'

const credentials: CosyCredentials = { userID: 'test-user', authToken: 'test-token', name: '', email: '', machineID: 'test-machine' }
const options = (signal?: AbortSignal): GenerateOptions => ({
  provider: 'qoder-official', model: 'test-model', signal,
  sessionId: 'test-session' as GenerateOptions['sessionId'],
  messages: [createUserMessage({ content: [{ type: 'text', text: 'Hello' }], source: { kind: 'user' } })],
})
const envelope = (body: unknown, statusCodeValue = 200): string => `data: ${JSON.stringify({ statusCodeValue, body: JSON.stringify(body) })}\n`
const queueFrame = envelope({ code: '10605', data: { isQueued: true, queueCount: 2, waitTime: 4 } }, 429)
const success = (): Response => new Response(envelope({ choices: [{ delta: { content: 'Answer' } }] }) + 'data: [DONE]\n')
const collect = async (stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> => {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function clock(): QueueClock & { elapsed: number; sleeps: number[] } {
  return { elapsed: 0, sleeps: [], now() { return this.elapsed }, async sleep(ms, signal) {
    if (signal?.aborted) throw new Error('aborted')
    this.sleeps.push(ms)
    this.elapsed += ms
  } }
}

function decode(init?: RequestInit): QoderWireRequest {
  const custom = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!'
  const standard = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const value = Buffer.from(init?.body as Uint8Array).toString()
  const rearranged = [...value].map(char => char === '$' ? '=' : standard[custom.indexOf(char)]).join('')
  const third = Math.floor(rearranged.length / 3)
  const original = rearranged.slice(-third) + rearranged.slice(third, -third) + rearranged.slice(0, third)
  return JSON.parse(Buffer.from(original, 'base64').toString())
}

function deps(fetch: typeof globalThis.fetch, extra: Partial<QoderChatDependencies> = {}): QoderChatDependencies {
  return { fetch, region: 'global', responseHeaderTimeoutMs: 1000, streamIdleTimeoutMs: 1000, queueClock: clock(), ...extra }
}

function queueOptions(fetch: typeof globalThis.fetch, extra: Partial<ModelQueueOptions> = {}): ModelQueueOptions {
  return { fetch, region: 'global', requestSetId: 'call', sessionId: 'wire-session', dshSessionId: 'session', model: 'model',
    credentials: async () => credentials, clock: clock(), ...extra }
}

test('queue envelopes support nested string bodies and validate optional fields', () => {
  assert.equal(queuedError({ body: JSON.stringify({ error: { code: 10605 } }) })?.code, 'QODER_MODEL_QUEUED')
  assert.equal(queuedError({ queue: { isQueued: true } })?.queue.isQueued, true)
  assert.equal(queuedError({ message: '10605 isQueued=true' }), undefined)
  assert.equal(queuedError({ code: '10604' }), undefined)
  assert.deepEqual(parseQueueStatus({ result: { isQueued: 'false', queueCount: '3', waitTime: -1, retryAfterSeconds: 'invalid' } }), {
    isQueued: false, queueCount: 3,
  })
  const cyclic: Record<string, unknown> = {}
  cyclic.body = cyclic
  assert.equal(queuedError(cyclic), undefined)
  assert.equal(parseQueueStatus({ isQueued: 'no' }), undefined)
})

test('steps in the same turn preserve queue identity while rotating request identity', async () => {
  const a = await buildQoderRequestBody(options(), credentials.userID)
  const b = await buildQoderRequestBody(options(), credentials.userID)
  assert.equal(a.request_set_id, b.request_set_id)
  assert.equal(a.business.id, b.business.id)
  assert.notEqual(a.request_id, b.request_id)
  assert.equal(a.request_id, a.chat_record_id)
  assert.equal(a.session_id, b.session_id)
})

test('SSE queue recovery preserves identity, signs polls, and finishes only after generation', async () => {
  const asks: QoderWireRequest[] = []
  const order: string[] = []
  const updates: QoderQueueUpdate[] = []
  let polls = 0
  let finishPayload: Record<string, unknown> | undefined
  const fakeClock = clock()
  const fetch = (async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/queue/status')) {
      order.push('poll')
      assert.equal(url.searchParams.get('requestSetId'), asks[0].request_set_id)
      const headers = new Headers(init?.headers)
      assert.match(headers.get('authorization')!, /^Bearer COSY\./)
      assert.equal(headers.get('x-request-id'), asks[0].request_id)
      assert.equal(headers.get('x-session-id'), asks[0].session_id)
      return Response.json(++polls === 1 ? { data: { isQueued: true, retryAfterSeconds: 0.1, queueCount: 1 } } : { isQueued: false, retryAfterSeconds: 0.1 })
    }
    if (url.pathname.endsWith('/ask/finish')) {
      order.push('finish')
      const body = JSON.parse(String(init?.body))
      assert.equal(body.encodeVersion, '1')
      finishPayload = JSON.parse(body.payload)
      return Response.json({})
    }
    order.push('ask')
    asks.push(decode(init))
    assert.equal(new Headers(init?.headers).get('x-request-id'), asks.at(-1)!.request_id)
    assert.equal(new Headers(init?.headers).get('x-session-id'), asks.at(-1)!.session_id)
    return asks.length === 1 ? new Response(queueFrame) : success()
  }) as typeof globalThis.fetch
  const chunks = await collect(streamQoderChat(options(), undefined, credentials, [], deps(fetch, { queueClock: fakeClock, onQueueUpdate: update => updates.push(update) })))
  assert.deepEqual(order, ['ask', 'poll', 'poll', 'ask', 'finish'])
  assert.deepEqual(fakeClock.sleeps, [500, 500])
  assert.equal(asks[0].request_set_id, asks[1].request_set_id)
  assert.equal(asks[0].session_id, asks[1].session_id)
  assert.notEqual(asks[0].request_id, asks[1].request_id)
  assert.equal(asks[1].chat_record_id, asks[1].request_id)
  assert.equal(asks[1].is_retry, false)
  assert.equal(finishPayload?.request_set_id, asks[0].request_set_id)
  assert.equal(finishPayload?.model_key, 'test-model')
  assert.equal(typeof finishPayload?.time_consumed, 'number')
  assert.equal(chunks.filter(chunk => chunk.type === 'finish').length, 1)
  assert.ok(updates.some(update => update.type === 'waiting' && update.snapshot.waitTimeMs === 4000))
  assert.equal(updates.at(-1)?.type, 'clear')
})

test('normal generation never calls queue status or finish', async () => {
  let calls = 0
  await collect(streamQoderChat(options(), undefined, credentials, [], deps((async () => { calls++; return success() }) as typeof fetch)))
  assert.equal(calls, 1)
})

for (const delta of [{ content: 'partial' }, { reasoning_content: 'thinking' }, { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'tool', arguments: '{' } }] }]) {
  test(`queue after ${Object.keys(delta)[0]} never polls or replays`, async () => {
    let calls = 0
    let finishes = 0
    const fetch = (async (input) => {
      if (String(input).includes('/ask/finish')) { finishes++; return Response.json({}) }
      calls++
      return new Response(envelope({ choices: [{ delta }] }) + queueFrame)
    }) as typeof globalThis.fetch
    await assert.rejects(collect(streamQoderChat(options(), undefined, credentials, [], deps(fetch))), { code: 'QODER_QUEUE_AFTER_OUTPUT' })
    assert.equal(calls, 1)
    assert.equal(finishes, 1)
  })
}

test('HTTP queue error is recovered, but ordinary HTTP failure is not', async () => {
  let asks = 0
  const fetch = (async input => {
    if (String(input).includes('/queue/status')) return Response.json({ isQueued: false })
    if (String(input).includes('/ask/finish')) return Response.json({})
    return ++asks === 1 ? Response.json({ error: { code: '10605' } }, { status: 503 }) : success()
  }) as typeof globalThis.fetch
  await collect(streamQoderChat(options(), undefined, credentials, [], deps(fetch)))
  assert.equal(asks, 2)
  await assert.rejects(collect(streamQoderChat(options(), undefined, credentials, [], deps((async () => new Response('down', { status: 503 })) as typeof globalThis.fetch))), { code: 'SERVER' })
})

test('queue budget is cumulative across recovery and includes ready delay', async () => {
  const fakeClock = clock()
  const queue = new ModelQueue(queueOptions((async () => Response.json({ isQueued: false, retryAfterSeconds: 0.5 })) as typeof fetch, { maxWaitMs: 900, clock: fakeClock }))
  await queue.wait({}, 'attempt1')
  await assert.rejects(queue.wait({}, 'attempt2'), { code: 'QODER_QUEUE_TIMEOUT' })
  assert.deepEqual(fakeClock.sleeps, [500, 400])
})

test('queue polls immediately, retries three consecutive failures, and aborts 404 immediately', async () => {
  const fakeClock = clock()
  let polls = 0
  const queue = new ModelQueue(queueOptions((async () => { polls++; throw new Error('offline') }) as typeof fetch, { clock: fakeClock }))
  await assert.rejects(queue.wait({}, 'attempt'), { code: 'QODER_QUEUE_FAILED' })
  assert.equal(polls, 3)
  assert.deepEqual(fakeClock.sleeps, [30_000, 30_000])
  polls = 0
  const unavailable = new ModelQueue(queueOptions((async () => { polls++; return new Response('', { status: 404 }) }) as typeof fetch))
  await assert.rejects(unavailable.wait({}, 'attempt'), { code: 'QODER_QUEUE_UNAVAILABLE' })
  assert.equal(polls, 1)
})

test('successful poll resets failure streak and ready cannot exceed ten recoveries', async () => {
  let polls = 0
  const queue = new ModelQueue(queueOptions((async () => {
    polls++
    if ([1, 2, 4, 5].includes(polls)) throw new Error('offline')
    return Response.json({ isQueued: polls === 3, retryAfterSeconds: 0.5 })
  }) as typeof fetch))
  await queue.wait({}, 'attempt')
  assert.equal(polls, 6)
  for (let i = 0; i < 9; i++) await queue.wait({}, `attempt${i}`)
  await assert.rejects(queue.wait({}, 'limit'), { code: 'QODER_QUEUE_LIMIT' })
  assert.equal(polls, 15)
})

test('poll authentication refreshes once and re-signs with fresh credentials', async () => {
  const refreshes: boolean[] = []
  let polls = 0
  const auth: string[] = []
  const queue = new ModelQueue(queueOptions((async (_url, init) => {
    auth.push(new Headers(init?.headers).get('authorization')!)
    return ++polls === 1 ? new Response('', { status: 401 }) : Response.json({ isQueued: false })
  }) as typeof fetch, { credentials: async force => { refreshes.push(force); return { ...credentials, authToken: force ? 'fresh-token' : 'old-token' } } }))
  await queue.wait({}, 'attempt')
  assert.deepEqual(refreshes, [false, true])
  assert.notEqual(auth[0], auth[1])
})

test('caller cancellation aborts polling but cleanup uses an independent live signal', async () => {
  const caller = new AbortController()
  let finish = 0
  const updates: QoderQueueUpdate[] = []
  const fetch = (async (input, init) => {
    if (String(input).includes('/ask/finish')) {
      finish++
      assert.equal(init?.signal?.aborted, false)
      return Response.json({})
    }
    if (String(input).includes('/queue/status')) {
      caller.abort()
      return new Promise((_resolve, reject) => {
        if (init?.signal?.aborted) reject(new DOMException('aborted', 'AbortError'))
        else init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      })
    }
    return new Response(queueFrame)
  }) as typeof globalThis.fetch
  await assert.rejects(collect(streamQoderChat(options(caller.signal), undefined, credentials, [], deps(fetch, { onQueueUpdate: update => updates.push(update) }))), { code: 'ABORTED' })
  assert.equal(finish, 1)
  assert.equal(updates.at(-1)?.type, 'clear')
})

test('a stalled poll exhausts the queue budget instead of hanging', async () => {
  const queue = new ModelQueue(queueOptions((async () => new Promise<Response>(() => {})) as typeof fetch, { maxWaitMs: 15, clock: undefined }))
  await assert.rejects(queue.wait({}, 'attempt'), { code: 'QODER_QUEUE_TIMEOUT' })
})

test('finish failure does not replace a successful response or issue extra asks', async () => {
  let asks = 0
  let warnings = 0
  const fetch = (async input => {
    if (String(input).includes('/ask/finish')) throw new Error('offline')
    if (String(input).includes('/queue/status')) return Response.json({ isQueued: false })
    return ++asks === 1 ? new Response(queueFrame) : success()
  }) as typeof globalThis.fetch
  const chunks = await collect(streamQoderChat(options(), undefined, credentials, [], deps(fetch, { logger: { warn: () => { warnings++ } } })))
  assert.equal(chunks.at(-1)?.type, 'finish')
  assert.equal(asks, 2)
  assert.equal(warnings, 1)
})

test('invalid states and subscriber changes are terminal queue errors', async () => {
  const invalid = new ModelQueue(queueOptions((async () => Response.json({ serviceAvailable: true })) as typeof fetch))
  await assert.rejects(invalid.wait({}, 'attempt'), { code: 'QODER_QUEUE_INVALID_STATE' })
  await assert.rejects(collect(streamQoderChat(options(), undefined, credentials, [], deps((async () => new Response(queueFrame)) as typeof fetch, {
    resolveCredentials: async () => ({ ...credentials, userID: 'another-subscriber' }),
  }))), { code: 'QODER_QUEUE_IDENTITY' })
  assert.equal(queueInterval(0), 500)
  assert.equal(queueInterval(100), 30_000)
  assert.equal(queueInterval(), 30_000)
})

test('queue waiting outlives the completed ask attempt header and idle timers', async () => {
  let asks = 0
  const fetch = (async input => {
    if (String(input).includes('/queue/status')) {
      await delay(25)
      return Response.json({ isQueued: false })
    }
    if (String(input).includes('/ask/finish')) return Response.json({})
    return ++asks === 1 ? new Response(queueFrame) : success()
  }) as typeof globalThis.fetch
  await collect(streamQoderChat(options(), undefined, credentials, [], deps(fetch, {
    responseHeaderTimeoutMs: 5, streamIdleTimeoutMs: 5, modelQueueMaxWaitMs: 1000, queueClock: undefined,
  })))
  assert.equal(asks, 2)
})

test('a stalled response body is cancelled when the queue budget expires', async () => {
  let cancelled = false
  const fetch = (async () => new Response(new ReadableStream({ cancel() { cancelled = true } }))) as typeof globalThis.fetch
  const queue = new ModelQueue(queueOptions(fetch, { maxWaitMs: 15, clock: undefined }))
  await assert.rejects(queue.wait({}, 'attempt'), { code: 'QODER_QUEUE_TIMEOUT' })
  assert.equal(cancelled, true)
})

test('cleanup is once per queued model and bounded at three seconds including credentials', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let cleanupSignal: AbortSignal | undefined
  let warnings = 0
  let httpCalls = 0
  const queue = new ModelQueue(queueOptions((async () => { httpCalls++; return Response.json({}) }) as typeof fetch, {
    credentials: async (_refresh, signal) => {
      cleanupSignal = signal
      return new Promise<CosyCredentials>(() => {})
    },
    logger: { warn: () => { warnings++ } },
  }))
  queue.entered({ modelKey: 'model' })
  queue.entered({ modelKey: 'model' })
  const finished = queue.finish(1500)
  await setImmediate()
  assert.equal(cleanupSignal?.aborted, false)
  t.mock.timers.tick(3000)
  await finished
  assert.equal(cleanupSignal?.aborted, true)
  assert.equal(warnings, 1)
  assert.equal(httpCalls, 0)
  await queue.finish(2000)
  assert.equal(warnings, 1)
})

test('cancellation interrupts a poll delay before another upstream request', async () => {
  const caller = new AbortController()
  let polls = 0
  let observedWait!: () => void
  const sleeping = new Promise<void>(resolve => { observedWait = resolve })
  const queue = new ModelQueue(queueOptions((async () => { polls++; return Response.json({ isQueued: true, retryAfterSeconds: 30 }) }) as typeof fetch, {
    signal: caller.signal,
    clock: {
      now: () => performance.now(),
      sleep: async (_ms, signal) => {
        observedWait()
        await new Promise<void>((_resolve, reject) => signal?.addEventListener('abort', () => reject(new QoderLlmError('aborted', 'ABORTED')), { once: true }))
      },
    },
  }))
  const waiting = queue.wait({}, 'attempt')
  await sleeping
  caller.abort()
  await assert.rejects(waiting, { code: 'ABORTED' })
  assert.equal(polls, 1)
})


test('two queued steps share the turn lease, have independent UI call ids, and release once at turn end', async () => {
  const runs = new QoderQueueLeases()
  runs.start('test-session', 1)
  const asks: QoderWireRequest[] = []
  const snapshots = new Set<string>()
  let finishes = 0
  let polls = 0
  const send = (async (input, init) => {
    const url = String(input)
    if (url.includes('/queue/status')) {
      polls++
      return Response.json(polls % 2 ? { isQueued: true, retryAfterSeconds: 0 } : { isQueued: false })
    }
    if (url.includes('/ask/finish')) { finishes++; return Response.json({}) }
    asks.push(decode(init))
    return asks.length % 2 ? new Response(queueFrame) : success()
  }) as typeof fetch
  for (let step = 0; step < 2; step++) {
    await collect(streamQoderChat(options(), undefined, credentials, [], deps(send, {
      onQueueLease: runs.retain,
      onQueueUpdate: update => { if (update.type === 'waiting') snapshots.add(update.snapshot.callId) },
    })))
    assert.equal(finishes, 0)
  }
  assert.equal(snapshots.size, 2)
  assert.equal(asks[0].request_set_id, asks[2].request_set_id)
  await runs.end('test-session', 1)
  assert.equal(finishes, 1)
  await runs.dispose()
  assert.equal(finishes, 1)
})

test('auxiliary queued calls finish independently without retaining the subscriber turn lease', async () => {
  let retained = 0
  let asks = 0
  let finishes = 0
  const send = (async input => {
    const url = String(input)
    if (url.includes('/queue/status')) return Response.json({ isQueued: false })
    if (url.includes('/ask/finish')) { finishes++; return Response.json({}) }
    return ++asks === 1 ? new Response(queueFrame) : success()
  }) as typeof fetch
  await collect(streamQoderChat({ ...options(), purpose: 'session-title' }, undefined, credentials, [], deps(send, {
    onQueueLease: () => { retained++; return true },
  })))
  assert.equal(retained, 0)
  assert.equal(finishes, 1)
})


test('terminal queue failures cannot restart a queue budget through the default DSH retry policy', () => {
  const policy = resolveRetryPolicy(undefined, 'queue-test')
  assert.equal(policy.mode, 'normal')
  if (policy.mode !== 'normal') throw new Error('Expected bounded default retry policy')
  for (const code of ['QODER_QUEUE_FAILED', 'QODER_QUEUE_TIMEOUT', 'QODER_QUEUE_LIMIT', 'QODER_QUEUE_AFTER_OUTPUT', 'QODER_QUEUE_UNAVAILABLE', 'QODER_QUEUE_INVALID_STATE', 'QODER_QUEUE_IDENTITY']) {
    const failure = queueFailure('Model queue recovery ended.', code)
    assert.equal(policy.retryableCodes.includes(failure.code), false)
    assert.equal(failure.failure.providerRetryAfterMs, undefined)
    assert.equal(failure.upstreamCode, '10605')
  }
})

test('a delayed old finish cannot release the next real turn lease after identical compacted input', async () => {
  const runs = new QoderQueueLeases()
  const sessionId = 'delayed-finish-regression'
  const input = { ...options(), sessionId: sessionId as GenerateOptions['sessionId'] }
  const asks: QoderWireRequest[] = []
  const attempts = new Map<string, number>()
  const activeLeases = new Set<string>()
  let finishStarted!: () => void
  const finishing = new Promise<void>(resolve => { finishStarted = resolve })
  let completeOldFinish!: () => void
  let finishCalls = 0
  const transport = createQoderTransport({
    region: 'global', resolvePat: async () => 'offline-pat', resolveMachineId: () => 'offline-machine',
    captureQueueLeaseOwner: runs.capture,
    fetch: (async (input, init) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/jobToken/exchange')) return Response.json({ token: 'offline-token' })
      if (url.pathname.endsWith('/userinfo')) return Response.json({ id: 'offline-user' })
      if (url.pathname.endsWith('/queue/status')) {
        activeLeases.add(url.searchParams.get('requestSetId')!)
        return Response.json({ isQueued: false })
      }
      if (url.pathname.endsWith('/ask/finish')) {
        const payload = JSON.parse(JSON.parse(String(init?.body)).payload)
        if (++finishCalls === 1) return new Promise<Response>(resolve => {
          completeOldFinish = () => { activeLeases.delete(payload.request_set_id); resolve(Response.json({})) }
          finishStarted()
        })
        activeLeases.delete(payload.request_set_id)
        return Response.json({})
      }
      const request = decode(init)
      asks.push(request)
      const attempt = (attempts.get(request.request_set_id) ?? 0) + 1
      attempts.set(request.request_set_id, attempt)
      return attempt % 2 ? new Response(queueFrame) : success()
    }) as typeof fetch,
  })
  runs.start(sessionId, 1)
  await collect(transport.stream(input))
  await collect(transport.stream(input))
  assert.equal(asks[0].request_set_id, asks[2].request_set_id)
  assert.equal(finishCalls, 0)
  const oldEnding = runs.end(sessionId, 1)
  await finishing
  try {
    runs.start(sessionId, 2)
    // The earlier occurrence has been trimmed: the next turn presents the identical message list.
    await collect(transport.stream(input))
    await collect(transport.stream(input))
  } finally {
    completeOldFinish()
    await oldEnding
  }
  try {
    assert.notEqual(asks[0].request_set_id, asks[4].request_set_id)
    assert.notEqual(asks[0].business.id, asks[4].business.id)
    assert.equal(asks[4].request_set_id, asks[6].request_set_id)
    assert.equal(asks[4].business.id, asks[6].business.id)
    assert.ok(activeLeases.has(asks[4].request_set_id))
    assert.equal(finishCalls, 1)
  } finally { await runs.end(sessionId, 2); await runs.dispose() }
  assert.equal(activeLeases.size, 0)
  assert.equal(finishCalls, 2)
})
