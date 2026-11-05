import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session } from '@deepseek-ai/dsh-session'
import { SessionId, type TurnEndReason } from '@deepseek-ai/dsh-session/types'
import { bindQoderQueueLeases, QoderQueueLeases } from '../src/dsh/queue-leases.ts'
import { createQoderTransport, type QoderTransportOptions } from '../src/qoder/transport/index.ts'
import { retainQoderBusiness, type QoderBusinessRequest, type QoderBusinessFinishDependencies } from '../src/qoder/transport/business-finish.ts'
import { computeSigPath, type CosyCredentials } from '../src/qoder/transport/wire/cosy.ts'
import { qoderEncodeBody } from '../src/qoder/transport/wire/encoding.ts'
import type { QoderBusiness } from '../src/qoder/transport/wire/model-types.ts'
import { deferred, mockTime, nextTurn } from './helpers/timing.ts'

const credentials: CosyCredentials = { userID: 'finish-user', authToken: 'finish-token', name: '', email: '', machineID: 'finish-machine', organizationId: 'finish-org' }
const business: QoderBusiness = { product: 'cli', version: 'fixture', type: 'agent', id: 'business', name: 'original prompt', begin_at: 1, stage: 'start' }
const request = (): GenerateOptions => ({
  provider: 'dsh-provider-qoder', model: 'model-a', sessionId: SessionId('finish-session'),
  messages: [createUserMessage({ content: [{ type: 'text', text: 'original prompt' }], source: { kind: 'user' } })],
})
const dispatched = (): QoderBusinessRequest => ({ business: { ...business }, credentials: { ...credentials }, sessionId: 'wire-session', modelKey: 'model-a' })

interface FinishEvent {
  event_time: number
  event_type: string
  mid: string
  aid: string
  rid: string
  oid: string
  yid: string
  uid: string
  event_data: { session_id: string; business: Omit<QoderBusiness, 'begin_at'> & { model_key?: string; end_at: number } }
}

function decode(body: string): Record<string, any> {
  const custom = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!'
  const standard = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const translated = Array.from(body, char => char === '$' ? '=' : standard[custom.indexOf(char)]).join('')
  const third = Math.floor(translated.length / 3)
  const original = translated.slice(-third) + translated.slice(third, -third) + translated.slice(0, third)
  return JSON.parse(Buffer.from(original, 'base64').toString())
}

function finishEvent(init?: RequestInit): FinishEvent {
  const outer = decode(String(init?.body))
  assert.equal(outer.encodeVersion, '1')
  assert.equal(qoderEncodeBody(JSON.stringify(outer)), init?.body)
  return JSON.parse(outer.payload)
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<void> { for await (const _chunk of stream) { /* drain */ } }
function response(protocol: 'legacy' | 'http'): Response {
  const body = { choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] }
  return new Response(`data: ${JSON.stringify(protocol === 'legacy' ? { statusCodeValue: 200, body: JSON.stringify(body) } : body)}\n\ndata: [DONE]\n\n`)
}

function transportOptions(runs: QoderQueueLeases, fetch: typeof globalThis.fetch): QoderTransportOptions {
  return { region: 'global', resolvePat: async () => { throw new Error('PAT must not be resolved') },
    resolveCredential: async () => ({ key: 'fixture', resolve: async () => credentials }),
    captureQueueLeaseOwner: runs.capture, fetch,
  }
}

for (const protocol of ['legacy', 'http'] as const) {
  test(`${protocol} reports one encoded, signed business finish only after committed turn/end`, async () => {
    const ctx = new Context()
    const runs = new QoderQueueLeases()
    const fiber = ctx.plugin(scope => { bindQoderQueueLeases(scope, runs) })
    await fiber.await()
    const session = Session.create(SessionId('finish-session'))
    ctx.emit('session/event', session, session.append('turn/start', { turn: 1 }))
    const asks: Array<{ business: QoderBusiness; sessionId: string }> = []
    const finishes: FinishEvent[] = []
    const transport = createQoderTransport({ ...transportOptions(runs, (async (input, init) => {
      const url = String(input)
      if (url.includes('/business/finish')) {
        assert.equal(url, 'https://api3.qoder.sh/algo/api/v2/service/business/finish?Encode=1')
        assert.equal(init?.method, 'POST')
        const event = finishEvent(init)
        const headers = new Headers(init?.headers)
        assert.equal(headers.get('cosy-user'), credentials.userID)
        assert.equal(headers.get('x-request-id'), event.rid)
        assert.equal(headers.get('x-session-id'), event.event_data.session_id)
        const auth = headers.get('authorization')!.slice('Bearer COSY.'.length)
        const split = auth.lastIndexOf('.')
        const signed = [auth.slice(0, split), headers.get('cosy-key'), headers.get('cosy-date'), init?.body, computeSigPath(url)].join('\n')
        assert.equal(createHash('md5').update(signed).digest('hex'), auth.slice(split + 1))
        finishes.push(event)
        return Response.json({})
      }
      const body = protocol === 'legacy' ? decode(String(init?.body)) : JSON.parse(String(init?.body))
      asks.push({ business: protocol === 'legacy' ? body.business : body.metadata.business, sessionId: protocol === 'legacy' ? body.session_id : body.metadata.context.session_id })
      return response(protocol)
    }) as typeof fetch), modelTransport: protocol })
    await collect(transport.stream(request()))
    await collect(transport.stream({ ...request(), messages: [] }))
    assert.equal(asks[0].business.id, asks[1].business.id)
    assert.equal(finishes.length, 0)
    const end = session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    ctx.emit('session/event', session, end)
    await nextTurn()
    assert.equal(finishes.length, 1)
    const event = finishes[0]
    assert.deepEqual({ ...event, rid: '', event_time: 0, event_data: undefined }, { event_type: 'BUSINESS_FINISH', mid: credentials.machineID, aid: '', rid: '', oid: credentials.organizationId, yid: '', uid: credentials.userID, event_time: 0, event_data: undefined })
    assert.deepEqual(event.event_data, { session_id: asks[0].sessionId, business: {
      product: asks[0].business.product, version: asks[0].business.version, type: 'agent', id: asks[0].business.id,
      model_key: 'model-a', end_at: end.time, stage: 'complete', name: asks[0].business.name,
    } })
    ctx.emit('session/event', session, end)
    await runs.dispose()
    await fiber.dispose()
    assert.equal(finishes.length, 1)
  })
}

test('business finish retains every model, region, subscriber and session scope across replaced transports', async () => {
  const runs = new QoderQueueLeases()
  runs.start('finish-session', 1)
  runs.start('other-session', 1)
  const sent: Array<{ url: string; event: FinishEvent }> = []
  const asks: QoderBusiness[] = []
  const send = (async (input, init) => {
    if (String(input).includes('/business/finish')) { sent.push({ url: String(input), event: finishEvent(init) }); return Response.json({}) }
    asks.push(decode(String(init?.body)).business)
    return response('legacy')
  }) as typeof fetch
  const options = transportOptions(runs, send)
  const first = createQoderTransport(options)
  await collect(first.stream(request()))
  // A replaced instance must not create a second finalizer for the same business.
  await collect(createQoderTransport(options).stream({ ...request(), messages: [] }))
  await collect(first.stream({ ...request(), model: 'model-b' }))
  await collect(first.stream(request()))
  await collect(createQoderTransport({ ...options, region: 'china' }).stream(request()))
  await collect(createQoderTransport({ ...options, resolveCredential: async () => ({ key: 'other', resolve: async () => ({ ...credentials, userID: 'other-user' }) }) }).stream(request()))
  await collect(first.stream({ ...request(), sessionId: SessionId('other-session') }))
  assert.equal(sent.length, 0)
  await runs.end('finish-session', 1, { stage: 'complete', endedAt: 1234 })
  assert.equal(sent.length, 5)
  assert.equal(new Set(sent.map(({ event }) => event.event_data.business.id)).size, 5)
  assert.ok(sent.some(({ url }) => url.startsWith('https://gateway.qoder.com.cn/')))
  assert.ok(sent.some(({ event }) => event.uid === 'other-user'))
  assert.ok(sent.every(({ event }) => event.event_data.business.end_at === 1234))
  await runs.end('other-session', 1)
  assert.equal(sent.length, 6)
  assert.equal(sent[5].event.event_data.business.id, asks[6].id)
})

test('auxiliary and standalone calls never finalize or displace a hosted subscriber business', async () => {
  const runs = new QoderQueueLeases()
  runs.start('finish-session', 1)
  const asks: QoderBusiness[] = []
  const sent: FinishEvent[] = []
  const transport = createQoderTransport(transportOptions(runs, (async (input, init) => {
    if (String(input).includes('/business/finish')) { sent.push(finishEvent(init)); return Response.json({}) }
    asks.push(decode(String(init?.body)).business)
    return response('legacy')
  }) as typeof fetch))
  await collect(transport.stream(request()))
  await collect(transport.stream({ ...request(), purpose: 'session-title' }))
  await collect(transport.stream({ ...request(), sessionId: undefined }))
  await collect(transport.stream(request()))
  assert.equal(asks[0].id, asks[3].id)
  assert.notEqual(asks[0].id, asks[1].id)
  await runs.end('finish-session', 1)
  assert.deepEqual(sent.map(event => event.event_data.business.id), [asks[0].id])
})

for (const imageFirst of [false, true]) {
  test(`ImageGen ${imageFirst ? 'before' : 'after'} the model shares one business finish with original agent metadata`, async () => {
    const runs = new QoderQueueLeases()
    runs.start('finish-session', 1)
    const sent: FinishEvent[] = []
    const ids: string[] = []
    let agentName: string | undefined
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
    const transport = createQoderTransport(transportOptions(runs, (async (input, init) => {
      if (String(input).includes('/business/finish')) { sent.push(finishEvent(init)); return Response.json({}) }
      const body = decode(String(init?.body))
      if (String(input).includes('/generateImage')) {
        ids.push(JSON.parse(body.payload).metadata.business.id)
        return Response.json({ data: [{ url: `data:image/png;base64,${png}` }] })
      }
      ids.push(body.business.id)
      agentName = body.business.name
      return response('legacy')
    }) as typeof fetch))
    const image = () => transport.generateImage!({ prompt: 'tool prompt', sessionId: 'finish-session' })
    if (imageFirst) await image()
    await collect(transport.stream(request()))
    if (!imageFirst) await image()
    assert.equal(ids[0], ids[1])
    assert.equal(sent.length, 0)
    await runs.end('finish-session', 1)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].event_data.business.type, 'agent')
    assert.equal(sent[0].event_data.business.model_key, 'model-a')
    assert.ok(agentName)
    assert.equal(sent[0].event_data.business.name, agentName)
  })
}

test('preparation completing after turn/end retains its original run and original credential lease', async () => {
  const runs = new QoderQueueLeases()
  runs.start('finish-session', 1)
  const waiting = deferred()
  const ready = deferred()
  const sent: FinishEvent[] = []
  const asks: QoderBusiness[] = []
  let oldPreparation = true
  const oldTransport = createQoderTransport({ ...transportOptions(runs, (async (input, init) => {
    if (String(input).includes('/business/finish')) { sent.push(finishEvent(init)); return Response.json({}) }
    asks.push(decode(String(init?.body)).business)
    return response('legacy')
  }) as typeof fetch), resolveCredential: async () => {
    if (oldPreparation) { oldPreparation = false; waiting.resolve(); await ready.promise }
    return { key: 'old', resolve: async () => credentials }
  } })
  const oldCall = collect(oldTransport.stream(request()))
  await waiting.promise
  await runs.end('finish-session', 1, { stage: 'abort', endedAt: 111 })
  runs.start('finish-session', 2)
  await collect(oldTransport.stream(request()))
  ready.resolve()
  await oldCall
  await nextTurn()
  assert.equal(sent.length, 1)
  assert.equal(sent[0].event_data.business.id, asks[1].id)
  assert.equal(sent[0].event_data.business.end_at, 111)
  assert.equal(sent[0].event_data.business.stage, 'abort')
  assert.notEqual(asks[0].id, asks[1].id)
  await runs.end('finish-session', 2)
  assert.equal(sent.length, 2)
  assert.equal(sent[1].event_data.business.id, asks[0].id)
})

test('committed reasons, replacement and disposal map to Qoder terminal stages', async () => {
  const ctx = new Context()
  const runs = new QoderQueueLeases()
  const fiber = ctx.plugin(scope => { bindQoderQueueLeases(scope, runs) })
  await fiber.await()
  const session = Session.create(SessionId('finish-session'))
  const pairs: Array<[TurnEndReason, string]> = [
    [{ kind: 'completed' }, 'complete'], [{ kind: 'aborted', reason: { kind: 'user' } }, 'abort'],
    [{ kind: 'error', error: { code: 'UNKNOWN', message: 'fixture' } }, 'error'],
    [{ kind: 'max-tokens' }, 'error'], [{ kind: 'blocked' }, 'abort'],
  ]
  const sent: FinishEvent[] = []
  const deps: QoderBusinessFinishDependencies = { region: 'global', resolveCredentials: async () => credentials, fetch: (async (_input, init) => { sent.push(finishEvent(init)); return Response.json({}) }) as typeof fetch }
  for (const [index, [reason, stage]] of pairs.entries()) {
    const turn = index + 1
    ctx.emit('session/event', session, session.append('turn/start', { turn }))
    retainQoderBusiness(runs.capture(session.id)?.run, dispatched(), deps)
    await runs.end(session.id, turn - 1)
    assert.equal(sent.length, index)
    const end = session.append('turn/end', { turn, reason })
    ctx.emit('session/event', session, end)
    await nextTurn()
    assert.equal(sent[index].event_data.business.stage, stage)
    assert.equal(sent[index].event_data.business.end_at, end.time)
  }
  runs.start(session.id, 6)
  retainQoderBusiness(runs.capture(session.id)?.run, dispatched(), deps)
  runs.start(session.id, 7)
  retainQoderBusiness(runs.capture(session.id)?.run, dispatched(), deps)
  await runs.dispose()
  assert.deepEqual(sent.slice(-2).map(event => event.event_data.business.stage), ['abort', 'abort'])
  await fiber.dispose()
})

for (const phase of ['credentials', 'fetch', 'body', 'forbidden-body'] as const) {
  test(`business finish deadline covers ${phase} even if the operation ignores abort`, async t => {
    const time = mockTime(t)
    const runs = new QoderQueueLeases()
    runs.start('session', 1)
    const lateCredentials = deferred<CosyCredentials>()
    let calls = 0
    let finished = false
    const logs: unknown[] = []
    retainQoderBusiness(runs.capture('session')?.run, dispatched(), {
      region: 'global', logger: { warn: (...args) => { logs.push(args) } },
      resolveCredentials: async () => phase === 'credentials' ? lateCredentials.promise : credentials,
      fetch: (async () => {
        calls++
        if (phase === 'fetch') return new Promise<Response>(() => {})
        return new Response(new ReadableStream({ cancel: () => new Promise<void>(() => {}) }), { status: phase === 'forbidden-body' ? 403 : 200 })
      }) as typeof fetch,
    })
    const closing = runs.end('session', 1).then(() => { finished = true })
    await nextTurn()
    time.tick(9999)
    await nextTurn()
    assert.equal(finished, false)
    time.tick(1)
    await closing
    assert.equal(finished, true)
    assert.equal(logs.length, 1)
    assert.ok(JSON.stringify(logs).includes('timeout'))
    assert.ok(!JSON.stringify(logs).includes(credentials.authToken))
    lateCredentials.resolve(credentials)
    await nextTurn()
    assert.equal(calls, phase === 'credentials' ? 0 : 1)
    await runs.dispose()
  })
}

test('business finish authenticates only with its captured subscriber and makes one bounded recovery', async () => {
  const runs = new QoderQueueLeases()
  const sent: FinishEvent[] = []
  const rejected: Array<string | undefined> = []
  const bodies: string[] = []
  runs.start('session', 1)
  retainQoderBusiness(runs.capture('session')?.run, dispatched(), {
    region: 'global', resolveCredentials: async (_signal, token) => { rejected.push(token); return { ...credentials, authToken: token ? 'fresh-token' : credentials.authToken } },
    fetch: (async (_input, init) => { sent.push(finishEvent(init)); bodies.push(String(init?.body)); return new Response(null, { status: sent.length === 1 ? 401 : 204 }) }) as typeof fetch,
  })
  await runs.end('session', 1)
  assert.equal(sent.length, 2)
  assert.deepEqual(rejected, [undefined, credentials.authToken])
  assert.equal(bodies[0], bodies[1])
  assert.equal(sent[0].rid, sent[1].rid)
  let wrongAccountCalls = 0
  for (const changed of [{ userID: 'other-user' }, { organizationId: 'other-org' }]) {
    runs.start('session', 2)
    retainQoderBusiness(runs.capture('session')?.run, dispatched(), {
      region: 'global', resolveCredentials: async () => ({ ...credentials, ...changed }),
      fetch: async () => { wrongAccountCalls++; return Response.json({}) },
    })
    await runs.end('session', 2)
  }
  assert.equal(sent.length, 2)
  assert.equal(wrongAccountCalls, 0)
})

test('forbidden business finish refreshes only explicit expiry, with official wrapper precedence', async () => {
  const cases: Array<[unknown, boolean]> = [
    [{ code: 105 }, true], [{ error: { code: ' 105 ' } }, true],
    [{ code: 403, body: JSON.stringify({ code: 105 }) }, true],
    [{ code: 'auth_error', providerError: { code: '105' } }, true],
    [{ code: 103, error: { code: 105 } }, false], [{ code: '101' }, false],
    [{ code: 112 }, false], [{ code: '10605' }, false], [{ message: '105' }, false],
    [JSON.stringify({ code: 105 }), false],
  ]
  for (const [body, expires] of cases) {
    const runs = new QoderQueueLeases()
    runs.start('session', 1)
    let calls = 0
    let refreshes = 0
    retainQoderBusiness(runs.capture('session')?.run, dispatched(), {
      region: 'global', resolveCredentials: async (_signal, rejected) => { if (rejected) refreshes++; return credentials },
      fetch: async () => { calls++; return Response.json(body, { status: 403 }) },
    })
    await runs.end('session', 1)
    assert.equal(calls, expires ? 2 : 1, JSON.stringify(body))
    assert.equal(refreshes, expires ? 1 : 0, JSON.stringify(body))
  }
})

test('later matching requests update the credential lease while preserving original agent metadata', async () => {
  const runs = new QoderQueueLeases()
  runs.start('finish-session', 1)
  const sent: FinishEvent[] = []
  let oldValid = true
  const dispatchedNames: string[] = []
  const send = (async (input, init) => {
    if (String(input).includes('/business/finish')) { sent.push(finishEvent(init)); return Response.json({}) }
    dispatchedNames.push(decode(String(init?.body)).business.name)
    return response('legacy')
  }) as typeof fetch
  const initial = createQoderTransport({ ...transportOptions(runs, send),
    resolveCredential: async () => ({ key: 'old', resolve: async () => { if (!oldValid) throw new Error('old lease revoked'); return credentials } }),
  })
  await collect(initial.stream(request()))
  oldValid = false
  const renewed = createQoderTransport({ ...transportOptions(runs, send),
    resolveCredential: async () => ({ key: 'renewed', resolve: async () => ({ ...credentials, authToken: 'renewed-token' }) }),
  })
  await collect(renewed.stream({ ...request(), messages: [createUserMessage({ content: [{ type: 'text', text: 'late context' }], source: { kind: 'user' } })] }))
  await runs.end('finish-session', 1)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].event_data.business.name, dispatchedNames[0])
})

test('validation failure and pre-cancellation do not register a business or resolve credentials', async () => {
  const runs = new QoderQueueLeases()
  runs.start('finish-session', 1)
  let resolutions = 0
  let calls = 0
  const transport = createQoderTransport({ ...transportOptions(runs, async () => { calls++; return Response.json({}) }),
    resolveCredential: async () => { resolutions++; return { key: 'fixture', resolve: async () => credentials } },
  })
  await assert.rejects(collect(transport.stream({ ...request(), reasoningEffort: 'unsupported' as GenerateOptions['reasoningEffort'] })))
  await assert.rejects(collect(transport.stream({ ...request(), signal: AbortSignal.abort() })))
  await runs.end('finish-session', 1)
  assert.equal(resolutions, 0)
  assert.equal(calls, 0)
})
