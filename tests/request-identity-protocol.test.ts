import assert from 'node:assert/strict'
import test from 'node:test'
import { mockTime } from './helpers/timing.ts'
import { type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { qoderIdeVersion } from '../src/qoder/transport/wire/client-identity.ts'
import { qoderEncodeBodyBytes } from '../src/qoder/transport/wire/encoding.ts'
import { streamModelServerChat, modelServerBody } from '../src/qoder/transport/model-server.ts'
import { streamQoderChat } from '../src/qoder/transport/chat.ts'
import { prepareQoderRequest } from '../src/qoder/transport/wire/prepare.ts'
import { buildQoderRequestBody } from '../src/qoder/transport/wire/serialize.ts'
import { QoderTurnTracker } from '../src/qoder/transport/wire/turn-identity.ts'
import type { QoderWireMessage } from '../src/qoder/transport/wire/model-types.ts'
import type { QoderWireRequest } from '../src/qoder/transport/wire/wire-types.ts'

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

function messages(text = 'Inspect the repository'): QoderWireMessage[] {
  return [{ role: 'user', content: text }]
}

function options(extra: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'dsh-provider-qoder',
    model: 'cmodel',
    messages: [],
    ...extra,
  }
}

/** Decode the legacy COSY body after qoder's reversible body encoding. */
function decodeLegacy(value: Uint8Array | string): QoderWireRequest {
  const custom = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!'
  const standard = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const encoded = typeof value === 'string' ? Buffer.from(value, 'latin1') : Buffer.from(value)
  const rearranged = [...encoded.toString()].map(char => char === '$' ? '=' : standard[custom.indexOf(char)]).join('')
  const third = Math.floor(rearranged.length / 3)
  const base64 = rearranged.slice(-third) + rearranged.slice(third, -third) + rearranged.slice(0, third)
  return JSON.parse(Buffer.from(base64, 'base64').toString()) as QoderWireRequest
}

type HttpRequestBody = {
  metadata: {
    context: {
      request_id: string
      request_set_id: string
      session_id: string
    }
    business: QoderWireRequest['business']
  }
}

function assertIdentity(identity: {
  request_id: string
  request_set_id: string
  chat_record_id: string
  session_id: string
  business: { id: string; version: string }
}): void {
  assert.match(identity.request_id, uuidV4)
  assert.match(identity.request_set_id, uuidV4)
  assert.match(identity.chat_record_id, uuidV4)
  assert.match(identity.session_id, uuidV4)
  assert.match(identity.business.id, uuidV4)
  assert.equal(identity.chat_record_id, identity.request_id)
  assert.equal(identity.business.version, qoderIdeVersion)
}

test('legacy and HTTP envelopes aggregate unscoped requests into one five-minute run', async () => {
  let now = 1_000
  const tracker = new QoderTurnTracker({ now: () => now })
  const request = options()
  const wireMessages = messages()

  const first = await prepareQoderRequest(request, 'subscriber-a', wireMessages, undefined, undefined, tracker, 'global')
  const second = await prepareQoderRequest(request, 'subscriber-a', wireMessages, undefined, undefined, tracker, 'global')
  const legacy = await buildQoderRequestBody(request, 'subscriber-a', wireMessages, undefined, undefined, tracker, 'global')
  const http = modelServerBody(await prepareQoderRequest(request, 'subscriber-a', wireMessages, undefined, undefined, tracker, 'global'))
  const legacyIdentity = {
    request_id: legacy.request_id,
    request_set_id: legacy.request_set_id,
    chat_record_id: legacy.chat_record_id,
    session_id: legacy.session_id,
    business: legacy.business,
  }
  const httpMetadata = http.metadata as { context: { request_id: string; request_set_id: string; session_id: string }; business: { id: string; version: string } }
  const httpIdentity = {
    request_id: httpMetadata.context.request_id,
    request_set_id: httpMetadata.context.request_set_id,
    chat_record_id: httpMetadata.context.request_id,
    session_id: httpMetadata.context.session_id,
    business: httpMetadata.business,
  }

  assertIdentity(legacyIdentity)
  assertIdentity(httpIdentity)
  assert.equal(first.sessionId, second.sessionId)
  assert.equal(first.business.id, second.business.id)
  assert.equal(first.requestSetId, second.requestSetId)
  assert.notEqual(first.chatRecordId, second.chatRecordId)
  assert.equal(legacy.session_id, first.sessionId)
  assert.equal(legacy.request_set_id, first.requestSetId)
  assert.equal(legacy.business.id, first.business.id)
  assert.equal(httpMetadata.context.session_id, first.sessionId)
  assert.equal(httpMetadata.context.request_set_id, first.requestSetId)
  assert.equal(httpMetadata.business.id, first.business.id)

  now += 5 * 60 * 1000
  const next = await prepareQoderRequest(request, 'subscriber-a', wireMessages, undefined, undefined, tracker, 'global')
  assert.equal(next.sessionId, first.sessionId)
  assert.notEqual(next.business.id, first.business.id)
  assert.notEqual(next.requestSetId, first.requestSetId)
})

test('unscoped auxiliary calls stay independent of the aggregation window', async () => {
  const tracker = new QoderTurnTracker({ now: () => 1_000 })
  const request = options({ purpose: 'compaction' })
  const wireMessages = messages('Summarize this session')
  const first = await prepareQoderRequest(request, 'subscriber-a', wireMessages, undefined, undefined, tracker, 'global')
  const second = await prepareQoderRequest(request, 'subscriber-a', wireMessages, undefined, undefined, tracker, 'global')
  assertIdentity({
    request_id: first.requestId,
    request_set_id: first.requestSetId,
    chat_record_id: first.chatRecordId,
    session_id: first.sessionId,
    business: first.business,
  })
  assert.notEqual(first.sessionId, second.sessionId)
  assert.notEqual(first.requestSetId, second.requestSetId)
  assert.notEqual(first.business.id, second.business.id)
})

test('legacy encoding carries the same UUID identity fields as the HTTP envelope', async () => {
  const tracker = new QoderTurnTracker({ now: () => 1_000 })
  const request = options()
  const prepared = await prepareQoderRequest(request, 'subscriber-a', messages(), undefined, undefined, tracker, 'global')
  const legacy = await buildQoderRequestBody(request, 'subscriber-a', messages(), undefined, undefined, tracker, 'global')
  const decoded = decodeLegacy(qoderEncodeBodyBytes(JSON.stringify(legacy)))
  assert.equal(decoded.request_set_id, prepared.requestSetId)
  assert.equal(decoded.session_id, prepared.sessionId)
  assert.equal(decoded.business.id, prepared.business.id)
  assert.equal(decoded.business.version, qoderIdeVersion)
  assertIdentity(decoded as {
    request_id: string
    request_set_id: string
    chat_record_id: string
    session_id: string
    business: { id: string; version: string }
  })
})

test('HTTP authentication recovery repeats the complete prepared identity', async t => {
  const clock = mockTime(t)
  const seen: HttpRequestBody[] = []
  let calls = 0
  const credentials = { userID: 'subscriber-http-auth', authToken: 'initial', name: '', email: '' }
  const response = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    seen.push(JSON.parse(String(init?.body)) as HttpRequestBody)
    calls += 1
    return calls === 1
      ? new Response('{"error":"unauthorized"}', { status: 401 })
      : new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
  }
  for await (const _chunk of streamModelServerChat(options(), undefined, credentials, messages(), {
    fetch: response as typeof fetch,
    region: 'global',
    responseHeaderTimeoutMs: 1_000,
    streamIdleTimeoutMs: 1_000,
    refreshCredentials: async () => {
      clock.tick(5 * 60 * 1_000)
      const next = await prepareQoderRequest(options(), credentials.userID, messages(),
        undefined, undefined, undefined, 'global')
      assert.notEqual(next.business.id, seen[0]!.metadata.business.id)
      return { ...credentials, authToken: 'refreshed' }
    },
  })) continue
  assert.equal(calls, 2)
  const first = seen[0]!
  const second = seen[1]!
  const firstIdentity = {
    request_id: first.metadata.context.request_id,
    request_set_id: first.metadata.context.request_set_id,
    chat_record_id: first.metadata.context.request_id,
    session_id: first.metadata.context.session_id,
    business: first.metadata.business,
  }
  const secondIdentity = {
    request_id: second.metadata.context.request_id,
    request_set_id: second.metadata.context.request_set_id,
    chat_record_id: second.metadata.context.request_id,
    session_id: second.metadata.context.session_id,
    business: second.metadata.business,
  }
  assertIdentity(firstIdentity)
  assertIdentity(secondIdentity)
  assert.equal(firstIdentity.request_id, secondIdentity.request_id)
  assert.equal(firstIdentity.request_set_id, secondIdentity.request_set_id)
  assert.equal(firstIdentity.session_id, secondIdentity.session_id)
  assert.deepEqual(firstIdentity.business, secondIdentity.business)
})

test('legacy authentication recovery repeats the complete prepared identity', async t => {
  const clock = mockTime(t)
  const seen: QoderWireRequest[] = []
  let calls = 0
  const credentials = { userID: 'subscriber-legacy-auth', authToken: 'initial', name: '', email: '' }
  const response = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    seen.push(decodeLegacy(init?.body as string))
    calls += 1
    return calls === 1
      ? new Response('{"error":"unauthorized"}', { status: 401 })
      : new Response('data: [DONE]\n\n')
  }
  for await (const _chunk of streamQoderChat(options(), undefined, credentials, messages(), {
    fetch: response as typeof fetch,
    region: 'global',
    requestCompression: false,
    responseHeaderTimeoutMs: 1_000,
    streamIdleTimeoutMs: 1_000,
    refreshCredentials: async () => {
      clock.tick(5 * 60 * 1_000)
      const next = await prepareQoderRequest(options(), credentials.userID, messages(),
        undefined, undefined, undefined, 'global')
      assert.notEqual(next.business.id, seen[0]!.business.id)
      return { ...credentials, authToken: 'refreshed' }
    },
  })) continue
  assert.equal(calls, 2)
  const first = seen[0]!
  const second = seen[1]!
  assertIdentity(first)
  assertIdentity(second)
  assert.equal(first.request_id, second.request_id)
  assert.equal(first.request_set_id, second.request_set_id)
  assert.equal(first.session_id, second.session_id)
  assert.deepEqual(first.business, second.business)
})
