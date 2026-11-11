/**
 * Per-turn Qoder request identity.
 *
 * Qoder groups consumption records by the identity a conversation request
 * carries, so one subscriber prompt must resolve to one record no matter how
 * many reasoning steps it runs, and the next prompt must open a new one.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { buildQoderRequestBody } from '../src/qoder/transport/wire/serialize.ts'
import { prepareQoderRequest } from '../src/qoder/transport/wire/prepare.ts'
import type { QoderWireMessage } from '../src/qoder/transport/wire/wire-types.ts'
import { QoderQueueLeases } from '../src/dsh/queue-leases.ts'
import { QoderTurnTracker, type QoderTurnMessage } from '../src/qoder/transport/wire/turn-identity.ts'

function user(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/** Wire-level user message, the shape the turn tracker inspects. */
function wireUser(text: string): QoderWireMessage {
  return { role: 'user', content: [{ type: 'text', text }] }
}

/** Wire-level assistant turn carrying a tool call. */
function wireToolCall(id: string): QoderWireMessage {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [{ id, type: 'function', function: { name: 'read', arguments: '{}' } }],
  }
}

/** Wire-level tool result. */
function wireToolResult(id: string): QoderWireMessage {
  return { role: 'tool', content: [{ type: 'text', text: 'file body' }], tool_call_id: id }
}

function injected(text: string): QoderTurnMessage {
  return { ...wireUser(text), sourceKind: 'host-context' }
}

function options(messages: GenerateOptions['messages'], sessionId?: string): GenerateOptions {
  return {
    provider: 'dsh-provider-qoder',
    model: 'cmodel',
    messages,
    ...sessionId === undefined ? {} : { sessionId },
  } as GenerateOptions
}

test('every step of one turn shares a single consumption record', () => {
  const tracker = new QoderTurnTracker()
  const session = 'identity-session-1'
  const prompt = wireUser('Fix the failing test')

  const first = tracker.resolveTurnRecordId(session, [prompt])
  const second = tracker.resolveTurnRecordId(session, [
    prompt,
    wireToolCall('call-1'),
    wireToolResult('call-1'),
  ])
  const third = tracker.resolveTurnRecordId(session, [
    prompt,
    wireToolCall('call-2'),
    injected('memory'),
    injected('<openviking-context>Relevant memory</openviking-context>'),
  ])

  assert.equal(typeof first, 'string')
  assert.equal(second, first)
  assert.equal(third, first)
})

test('the next subscriber prompt opens a new record', () => {
  const tracker = new QoderTurnTracker()
  const session = 'identity-session-2'
  const firstPrompt = wireUser('First request')
  const secondPrompt = wireUser('Second request')

  const first = tracker.resolveTurnRecordId(session, [firstPrompt])
  const second = tracker.resolveTurnRecordId(session, [firstPrompt, secondPrompt])

  assert.notEqual(second, first)
  // The new turn stays stable for the rest of its own steps.
  assert.equal(tracker.resolveTurnRecordId(session, [firstPrompt, secondPrompt, injected('more context')]), second)
})

test('mid-turn messages that are not a new prompt stay in the open record', () => {
  const tracker = new QoderTurnTracker()
  const session = 'identity-session-3'
  const prompt = wireUser('Review this change')
  const parentMessage = injected('Agent 32b2b19f-2a36-4b22-95e1-98700c0fa5af sent a message: also check the retry path')

  const first = tracker.resolveTurnRecordId(session, [prompt])
  const second = tracker.resolveTurnRecordId(session, [prompt, injected('memory')])
  const third = tracker.resolveTurnRecordId(session, [prompt, parentMessage])

  assert.equal(second, first)
  // A delegated agent's message belongs to this run, not to a second prompt.
  assert.equal(third, first)
})

test('a conversation without host context still splits per prompt', () => {
  const tracker = new QoderTurnTracker()
  const session = 'identity-session-5'
  const firstPrompt = wireUser('First')
  const secondPrompt = wireUser('Second')
  const thirdPrompt = wireUser('Third')

  const first = tracker.resolveTurnRecordId(session, [firstPrompt])
  const second = tracker.resolveTurnRecordId(session, [firstPrompt, secondPrompt])
  const third = tracker.resolveTurnRecordId(session, [firstPrompt, secondPrompt, thirdPrompt])

  assert.notEqual(second, first)
  assert.notEqual(third, second)
  // Re-resolving the same conversation is stable.
  assert.equal(tracker.resolveTurnRecordId(session, [firstPrompt, secondPrompt, thirdPrompt]), third)
})

test('source identifies host-injected context independently of wording', () => {
  const tracker = new QoderTurnTracker()
  const session = 'identity-session-4'
  const prompt = wireUser('Audit the transport')
  const injections = [
    injected('<system-reminder>Workspace instructions that are relevant</system-reminder>'),
    injected('New context wording'),
  ]

  const first = tracker.resolveTurnRecordId(session, [prompt])
  assert.equal(tracker.resolveTurnRecordId(session, [prompt, ...injections]), first)
  assert.equal(
    tracker.resolveTurnRecordId(session, [prompt, ...injections, injected('More context')]),
    first,
  )
})

test('sessions never share a record id', () => {
  const tracker = new QoderTurnTracker()

  const one = tracker.resolveTurnRecordId('identity-session-a', [wireUser('Same text')])
  const two = tracker.resolveTurnRecordId('identity-session-b', [wireUser('Same text')])

  assert.notEqual(one, two)
})

test('requests without a session identity stay independent records', () => {
  const tracker = new QoderTurnTracker()

  assert.equal(tracker.resolveTurnRecordId(undefined, [wireUser('Ping')]), null)
  assert.equal(tracker.resolveTurnRecordId('', [wireUser('Ping')]), null)
})

test('the request envelope keeps run identity and its injected timestamp across steps and renews them for the next prompt', async () => {
  let clock = 1000
  const tracker = new QoderTurnTracker({ now: () => clock })
  const session = 'identity-session-envelope'
  const prompt = user('Continue')
  const first = await buildQoderRequestBody(options([prompt], session), 'user-42', undefined, undefined, undefined, tracker)
  clock = 2000
  const second = await buildQoderRequestBody(options([prompt], session), 'user-42', undefined, undefined, undefined, tracker)
  clock = 3000
  const nextTurn = await buildQoderRequestBody(options([prompt, user('Next')], session), 'user-42', undefined, undefined, undefined, tracker)

  // The official client renews request_set_id once per agent run and sets
  // chat_record_id to the request's own id, so one run keeps one set id while
  // every request carries a fresh record id.
  assert.equal(first.request_set_id, second.request_set_id)
  assert.notEqual(first.chat_record_id, second.chat_record_id)
  assert.notEqual(first.request_id, second.request_id)
  assert.notEqual(nextTurn.request_set_id, first.request_set_id)
  for (const body of [first, second, nextTurn]) {
    assert.equal(body.request_id, body.chat_record_id)
    assert.equal(body.session_id, first.session_id)
  }
  assert.equal(first.business.id, second.business.id)
  assert.notEqual(nextTurn.business.id, first.business.id)
  assert.match(first.session_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu)
  assert.equal(first.business.begin_at, 1000)
  assert.equal(second.business.begin_at, 1000)
  assert.equal(nextTurn.business.begin_at, 3000)
})

test('an auxiliary host call never moves the open turn', async () => {
  const session = 'identity-session-auxiliary'
  const prompt = user('Refactor the parser')
  const opening = await buildQoderRequestBody(options([prompt], session), 'user-42')

  // Session title and compaction summary are routed through this provider with
  // the same session identity but a message list of their own.
  const [titleBody, summaryBody] = await Promise.all([
    buildQoderRequestBody({
      ...options([user('Generate the session title from this JSON array of human messages:')], session),
      purpose: 'session-title',
    } as GenerateOptions, 'user-42'),
    buildQoderRequestBody({
      ...options([prompt, user('You are now acting as a compaction engine for this AI coding assistant.')], session),
      purpose: 'compaction',
    } as GenerateOptions, 'user-42'),
  ])
  // The step after an auxiliary call still belongs to the subscriber's turn: the
  // auxiliary call must not have displaced the record it was riding alongside.
  const stepAfterAux = await buildQoderRequestBody(options([prompt], session), 'user-42')
  const continuation = await buildQoderRequestBody(options([prompt, user('Next prompt')], session), 'user-42')

  // The auxiliary calls stay outside the turn instead of stealing it.
  assert.notEqual(titleBody.business.id, opening.business.id)
  assert.notEqual(summaryBody.business.id, opening.business.id)
  assert.notEqual(titleBody.request_set_id, opening.request_set_id)
  assert.notEqual(summaryBody.request_set_id, opening.request_set_id)
  assert.equal(titleBody.session_id, opening.session_id)
  assert.equal(summaryBody.session_id, opening.session_id)
  assert.equal(stepAfterAux.business.id, opening.business.id)
  assert.equal(stepAfterAux.request_set_id, opening.request_set_id)
  // The subscriber's own next prompt still opens a turn of its own.
  assert.notEqual(continuation.business.id, opening.business.id)
  assert.notEqual(continuation.business.id, titleBody.business.id)
})

test('an auxiliary call does not refresh the standalone cache eviction timestamp', () => {
  let now = 0
  const tracker = new QoderTurnTracker({ now: () => now, maxSessions: 2, idleSessionTtlMs: 10 })
  const first = tracker.resolveTurnRecordId('first', [wireUser('First')])
  now = 2
  const second = tracker.resolveTurnRecordId('second', [wireUser('Second')])
  now = 19
  tracker.resolveTurnRecordId('first', [wireUser('Generate title')], 'auxiliary')
  now = 20
  tracker.resolveTurnRecordId('third', [wireUser('Third')])
  assert.equal(tracker.resolveTurnRecordId('second', [wireUser('Second')]), second)
  assert.notEqual(tracker.resolveTurnRecordId('first', [wireUser('First')]), first)
})

test('subscriber text that resembles a historical image marker opens a turn', async () => {
  const session = 'identity-session-image-marker'
  const prompt = user('Describe this screenshot')
  const first = await buildQoderRequestBody(options([prompt], session), 'user-42')
  const second = await buildQoderRequestBody(options([
    prompt,
    user('[1 image returned by the previous tool call]'),
  ], session), 'user-42')

  assert.notEqual(second.business.id, first.business.id)
  assert.notEqual(second.request_set_id, first.request_set_id)
})

test('a subscriber prompt that repeats host wording still opens a new turn', async () => {
  const session = 'identity-session-wording'
  const prompt = user('Fix the build')
  const first = await buildQoderRequestBody(options([prompt], session), 'user-42')
  const second = await buildQoderRequestBody(options([
    prompt,
    user('<system-reminder>Please keep this verbatim</system-reminder>'),
  ], session), 'user-42')

  assert.notEqual(second.business.id, first.business.id)
})

test('trimming history keeps the open turn', async () => {
  const session = 'identity-session-trim'
  const prompt = user('Investigate the failure')
  const followUp = user('And now the retry path')
  const first = await buildQoderRequestBody(options([prompt, followUp], session), 'user-42')
  // Compaction may drop the earlier messages; the surviving input still belongs
  // to the record it already opened.
  const trimmed = await buildQoderRequestBody(options([followUp], session), 'user-42')

  assert.equal(trimmed.business.id, first.business.id)
  assert.equal(trimmed.request_set_id, first.request_set_id)
})

test('DSH message IDs and sources guide standalone turns without reaching the wire', async () => {
  const tracker = new QoderTurnTracker()
  const build = (messages: GenerateOptions['messages']) =>
    buildQoderRequestBody(options(messages, 'standalone-metadata'), 'user-42', undefined, undefined, undefined, tracker)
  const prompt = user('Same input')
  const context = createUserMessage({
    content: [{ type: 'text', text: 'Unrecognized host wording' }],
    source: { kind: 'system-prompt' },
  })
  const first = await build([prompt])
  const projected = await build([{ ...prompt, content: [{ type: 'text', text: 'Projected input' }] }, context])
  const repeated = await build([user('Same input'), context])

  assert.equal(projected.business.id, first.business.id)
  assert.notEqual(repeated.business.id, first.business.id)
  assert.equal(projected.business.name, 'Same input')
  assert.equal(repeated.business.name, 'Same input')
  assert.deepEqual(projected.messages, [
    { role: 'user', content: 'Projected input' },
    { role: 'user', content: 'Unrecognized host wording' },
  ])
})

test('cold standalone runs name the latest user input and keep image-only names empty', async () => {
  const tracker = new QoderTurnTracker()
  const image = { type: 'image_url', image_url: { url: 'https://example.test/image.png' } } as const
  const build = (session: string, messages: QoderWireMessage[]) =>
    buildQoderRequestBody(options([], session), 'user-42', messages, undefined, undefined, tracker)
  const old = wireUser('Historical prompt')
  const text = await build('cold-text', [old, wireUser('  帮我写一个快速排序算法  ')])
  const mixed = await build('cold-mixed', [old, {
    role: 'user', content: [image, { type: 'text', text: '请分析这张架构图的缺陷' }],
  }])
  const onlyImage = await build('cold-image', [old, { role: 'user', content: [image] }])
  assert.equal(text.business.name, '帮我写一个快速排序算')
  assert.equal(mixed.business.name, '请分析这张架构图的缺')
  assert.equal(onlyImage.business.name, '')
})

test('repeating the same prompt still opens a distinct record per turn', () => {
  const tracker = new QoderTurnTracker()
  const session = 'identity-session-repeat'
  const prompt = wireUser('继续')

  const first = tracker.resolveTurnRecordId(session, [prompt])
  // The subscriber repeats the same text as the next prompt: same anchor, but a
  // different turn, so it must not reuse the previous record.
  const second = tracker.resolveTurnRecordId(session, [prompt, injected('memory between turns'), prompt])

  assert.notEqual(second, first)
  // The repeated turn is still stable for its own later steps.
  assert.equal(
    tracker.resolveTurnRecordId(session, [prompt, injected('memory between turns'), prompt, injected('more')]),
    second,
  )
})

test('the tracker keeps a bounded per-session identity and prefers idle sessions', () => {
  // Active sessions outnumber the ceiling: the ceiling has to win, so the
  // coldest conversation loses its state and reports a new agent run.
  const busy = new QoderTurnTracker({ maxSessions: 2, idleSessionTtlMs: 0 })
  const kept = busy.resolveBusinessId('identity-keep', [wireUser('keep')])
  const other = busy.resolveBusinessId('identity-other', [wireUser('other')])
  assert.equal(busy.resolveBusinessId('identity-keep', [wireUser('keep')]).businessId, kept.businessId)
  busy.resolveBusinessId('identity-third', [wireUser('third')])

  assert.equal(busy.resolveBusinessId('identity-keep', [wireUser('keep')]).businessId, kept.businessId)
  assert.notEqual(busy.resolveBusinessId('identity-other', [wireUser('other')]).businessId, other.businessId)

  // A conversation idle past the TTL is evicted before any active one, so a turn
  // that is still running is never split by the ceiling.
  let clock = 1_000_000
  const idle = new QoderTurnTracker({ maxSessions: 2, idleSessionTtlMs: 60_000, now: () => clock })
  const active = idle.resolveBusinessId('identity-active', [wireUser('active')])
  idle.resolveBusinessId('identity-stale', [wireUser('stale')])
  // Age the clock past the TTL, then touch the active conversation and add one.
  clock += 120_000
  idle.resolveBusinessId('identity-active', [wireUser('active')])
  idle.resolveBusinessId('identity-third', [wireUser('third')])

  assert.equal(idle.resolveBusinessId('identity-third', [wireUser('third')]).businessId.length, 36)
  assert.equal(idle.resolveBusinessId('identity-active', [wireUser('active')]).businessId, active.businessId)
})

test('the business id is stable for a turn and renews for the next one', () => {
  const tracker = new QoderTurnTracker()
  const session = 'identity-session-business-tracker'
  const first = tracker.resolveBusinessId(session, [wireUser('One')])
  const stillOpen = tracker.resolveBusinessId(session, [wireUser('One'), injected('context')])
  const next = tracker.resolveBusinessId(session, [wireUser('One'), injected('context'), wireUser('Two')])

  assert.equal(stillOpen.businessId, first.businessId)
  assert.equal(stillOpen.beginAt, first.beginAt)
  assert.notEqual(next.businessId, first.businessId)
  // An auxiliary call never opens or replaces a run.
  const auxiliary = tracker.resolveBusinessId(session, [wireUser('Generate the session title')], 'auxiliary')
  assert.notEqual(auxiliary.businessId, next.businessId)
  assert.equal(
    tracker.resolveBusinessId(session, [wireUser('One'), injected('context'), wireUser('Two')]).businessId,
    next.businessId,
  )
})

test('session_id stays stable across model switches in the same conversation, but agent run renews', async () => {
  const session = 'identity-session-model-switch'
  const prompt = user('Hello')
  const body1 = await buildQoderRequestBody({ ...options([prompt], session), model: 'model-a' } as GenerateOptions, 'user-42')
  const body2 = await buildQoderRequestBody({ ...options([prompt], session), model: 'model-b' } as GenerateOptions, 'user-42')
  // The conversation identity stays untouched.
  assert.equal(body1.session_id, body2.session_id)
  // The agent run and billing turn renew for the new model.
  assert.notEqual(body2.business.id, body1.business.id)
  assert.notEqual(body2.request_set_id, body1.request_set_id)
})

test('multiple user messages arriving in one turn open a new record', () => {
  const tracker = new QoderTurnTracker()
  const session = 'identity-session-multi-user'
  const firstPrompt = wireUser('First message')
  const secondPrompt = wireUser('Second message')

  // Both user messages arrive together at the start of a turn
  const firstTurn = tracker.resolveTurnIdentity(session, [firstPrompt, secondPrompt])
  assert.ok(firstTurn.requestSetId)

  // Continuation of the turn
  const step2 = tracker.resolveTurnIdentity(session, [
    firstPrompt,
    secondPrompt,
    wireToolCall('call-1'),
    wireToolResult('call-1'),
  ])
  assert.equal(step2.requestSetId, firstTurn.requestSetId)
  assert.equal(step2.businessId, firstTurn.businessId)

  // Next turn with two new messages
  const nextPrompt1 = wireUser('Next 1')
  const nextPrompt2 = wireUser('Next 2')
  const nextTurn = tracker.resolveTurnIdentity(session, [
    firstPrompt,
    secondPrompt,
    nextPrompt1,
    nextPrompt2,
  ])
  assert.notEqual(nextTurn.requestSetId, firstTurn.requestSetId)
  assert.notEqual(nextTurn.businessId, firstTurn.businessId)
})

test('history compaction with repeated prompt reconciles claimed counts and opens new turn', () => {
  const tracker = new QoderTurnTracker()
  const session = 'identity-session-compaction-repeat'
  const prompt = wireUser('Repeat prompt')

  const turn1 = tracker.resolveTurnIdentity(session, [prompt])
  const turn2 = tracker.resolveTurnIdentity(session, [prompt, prompt])
  assert.notEqual(turn2.requestSetId, turn1.requestSetId)

  // Compaction trims earlier messages, only 1 prompt remains in history
  const stepCompacted = tracker.resolveTurnIdentity(session, [prompt])
  assert.ok(stepCompacted.requestSetId)

  // Repeating prompt again opens turn 3
  const turn3 = tracker.resolveTurnIdentity(session, [prompt, prompt])
  assert.notEqual(turn3.requestSetId, turn2.requestSetId)
  assert.notEqual(turn3.businessId, turn2.businessId)
})



test('business stage advances within a turn and resets for the next subscriber prompt', async () => {
  const tracker = new QoderTurnTracker()
  const prompt = wireUser('First')
  const input = options([], 'stage-session')
  const first = await prepareQoderRequest(input, 'offline-user', [prompt], undefined, undefined, tracker)
  const retry = await prepareQoderRequest(input, 'offline-user', [prompt], undefined, undefined, tracker)
  retry.markStepCompleted()
  const second = await prepareQoderRequest(input, 'offline-user', [prompt], undefined, undefined, tracker)
  const third = await prepareQoderRequest(input, 'offline-user', [prompt, wireUser('Next')], undefined, undefined, tracker)
  assert.equal(first.business.stage, 'start')
  assert.equal(retry.business.stage, 'start')
  assert.equal(retry.business.id, first.business.id)
  assert.equal(second.business.stage, 'processing')
  assert.equal(third.business.stage, 'start')
  assert.equal(first.business.id, second.business.id)
  assert.notEqual(second.business.id, third.business.id)
})


test('provider identities isolate queue request sets between subscribers and regions', async () => {
  const input = options([user('Hello')], 'account-scoped-queue') as GenerateOptions
  const tracker = new QoderTurnTracker()
  const first = await buildQoderRequestBody(input, 'subscriber-a', undefined, undefined, undefined, tracker, 'global')
  const other = await buildQoderRequestBody(input, 'subscriber-b', undefined, undefined, undefined, tracker, 'global')
  const regional = await buildQoderRequestBody(input, 'subscriber-a', undefined, undefined, undefined, tracker, 'china')
  const same = await buildQoderRequestBody(input, 'subscriber-a', undefined, undefined, undefined, tracker, 'global')
  assert.notEqual(other.request_set_id, first.request_set_id)
  assert.notEqual(other.business.id, first.business.id)
  assert.notEqual(regional.request_set_id, first.request_set_id)
  assert.equal(same.request_set_id, first.request_set_id)
})

test('business name follows the prompt that opens each turn and stays frozen', () => {
  const tracker = new QoderTurnTracker()
  const session = 'business-name-session'
  const first = tracker.resolveTurnIdentity(session, [wireUser('Old prompt')])
  const next = tracker.resolveTurnIdentity(session, [wireUser('Old prompt'), wireUser('New prompt')])
  const continued = tracker.resolveTurnIdentity(session, [
    wireUser('Old prompt'),
    wireUser('New prompt'),
    injected('steering context'),
  ])

  assert.equal(first.businessName, 'Old prompt')
  assert.equal(next.businessName, 'New prompt')
  assert.equal(continued.businessName, 'New prompt')
})

test('unscoped conversation requests share a fixed five-minute run window', () => {
  let now = 10_000
  const tracker = new QoderTurnTracker({ now: () => now, maxSessions: 1 })
  const resolve = (scope: string, model = 'review-model') => tracker.resolveTurnIdentity(
    undefined,
    [wireUser('Review this tool call')],
    'conversation',
    undefined,
    model,
    undefined,
    { scope },
  )

  const first = resolve('global\0subscriber-a')
  now += 60_000
  // Active windows are not evicted merely because other scopes are observed.
  resolve('global\0subscriber-b')
  resolve('global\0subscriber-c')
  const same = resolve('global\0subscriber-a')
  assert.equal(same.sessionId, first.sessionId)
  assert.equal(same.businessId, first.businessId)
  assert.equal(same.requestSetId, first.requestSetId)

  now = 10_000 + 5 * 60 * 1000
  const next = resolve('global\0subscriber-a')
  assert.equal(next.sessionId, first.sessionId)
  assert.notEqual(next.businessId, first.businessId)
  assert.notEqual(next.requestSetId, first.requestSetId)
  assert.equal(next.businessStage, 'start')
})

test('unscoped auxiliary calls never claim the conversation aggregation window', () => {
  const tracker = new QoderTurnTracker({ now: () => 10_000 })
  const context = { scope: 'global\0subscriber-a' }
  const conversation = tracker.resolveTurnIdentity(undefined, [wireUser('Review')], 'conversation', undefined, 'model', undefined, context)
  const auxiliary = tracker.resolveTurnIdentity(undefined, [wireUser('Summarize')], 'auxiliary', undefined, 'model', undefined, context)
  const resumed = tracker.resolveTurnIdentity(undefined, [wireUser('Review')], 'conversation', undefined, 'model', undefined, context)

  assert.notEqual(auxiliary.sessionId, conversation.sessionId)
  assert.notEqual(auxiliary.businessId, conversation.businessId)
  assert.equal(resumed.sessionId, conversation.sessionId)
  assert.equal(resumed.businessId, conversation.businessId)
})

test('hosted turns survive injected context, projected history and steering, but honor model switches', async () => {
  const tracker = new QoderTurnTracker()
  const run = Object.freeze({ id: 'hosted-context' })
  const input = options([], 'hosted-context')
  const build = (messages: QoderWireMessage[], model = 'cmodel', purpose?: GenerateOptions['purpose']) =>
    prepareQoderRequest({ ...input, model, purpose }, 'user', messages, undefined, undefined, tracker, 'global', run)
  const first = await build([wireUser('Fix tests')])
  first.markStepCompleted()
  for (const messages of [
    [wireUser('Fix tests'), wireUser('Time sampled while preparing turn 1, step 2: now')],
    [wireUser('Fix tests'), wireUser('Current runtime context: none. Earlier runtime-context snapshots no longer apply.')],
    [wireUser('This is an automatically generated checkpoint condensing history')],
    [wireUser('Also check types')],
  ]) {
    const next = await build(messages)
    assert.equal(next.business.id, first.business.id)
    assert.equal(next.business.begin_at, first.business.begin_at)
    assert.equal(next.requestSetId, first.requestSetId)
    assert.equal(next.business.stage, 'processing')
    assert.notEqual(next.requestId, first.requestId)
  }
  const auxiliary = await build([wireUser('Title')], 'cmodel', 'session-title')
  assert.notEqual(auxiliary.business.id, first.business.id)
  assert.equal((await build([])).business.id, first.business.id)
  const switched = await build([], 'other-model')
  assert.notEqual(switched.business.id, first.business.id)
  assert.notEqual(switched.requestSetId, first.requestSetId)
  assert.equal(switched.business.stage, 'start')
  assert.equal((await build([], 'other-model')).business.id, switched.business.id)
})

test('completed host runs and standalone cache pressure cannot evict an active host run', async () => {
  const tracker = new QoderTurnTracker({ maxSessions: 2 })
  const runs = new QoderQueueLeases()
  runs.start('active', 1)
  const input = options([], 'active')
  const build = (session: string, run = runs.capture(session)?.run, region = 'global', user = 'user') =>
    buildQoderRequestBody({ ...input, sessionId: session as GenerateOptions['sessionId'] }, user,
      [wireUser('Hello')], undefined, undefined, tracker, region, run)
  const first = await build('active')
  for (let turn = 1; turn <= 80; turn++) {
    runs.start('other', turn)
    await build('other')
    await runs.end('other', turn)
    await build(`standalone-${turn}`)
  }
  const continued = await build('active')
  assert.equal(continued.business.id, first.business.id)
  assert.equal(continued.business.begin_at, first.business.begin_at)
  assert.equal(continued.request_set_id, first.request_set_id)
  assert.equal(continued.business.stage, 'start')
  const run = runs.capture('active')!.run
  assert.notEqual((await build('active', run, 'china')).business.id, first.business.id)
  assert.notEqual((await build('active', run, 'global', 'other-user')).business.id, first.business.id)
  assert.notEqual((await build('another-session', run)).business.id, first.business.id)
  await runs.dispose()
})

test('captured requests retain their identity after host end and cannot affect a new identical turn', async () => {
  const tracker = new QoderTurnTracker()
  const runs = new QoderQueueLeases()
  const input = options([], 'late-request')
  runs.start('late-request', 1)
  const old = runs.capture('late-request')!
  assert.equal(runs.capture('late-request')!.run, old.run)
  const build = (run = old.run) => buildQoderRequestBody(input, 'user', [wireUser('Hello')],
    undefined, undefined, tracker, 'global', run)
  const first = await build()
  await runs.end('late-request', 1)
  assert.equal(runs.capture('late-request'), undefined)
  runs.start('late-request', 2)
  const current = runs.capture('late-request')!
  const second = await build(current.run)
  const late = await build()
  assert.equal(late.business.id, first.business.id)
  assert.equal(late.request_set_id, first.request_set_id)
  assert.notEqual(second.business.id, first.business.id)
  assert.notEqual(second.request_set_id, first.request_set_id)
  assert.equal((await build(current.run)).business.id, second.business.id)
  assert.equal(old.retain({ key: 'late', sessionId: 'late-request', release: async () => {} }), false)
  await runs.dispose()
})

test('standalone tracking ignores a full time snapshot and accepts a similar subscriber prompt', () => {
  const tracker = new QoderTurnTracker()
  const prompt = wireUser('First prompt')
  const first = tracker.resolveTurnIdentity('time-context', [prompt])
  const timeSnapshot = injected(
    'Time sampled while preparing turn 1, step 2: 2026-11-05T15:40:21+08:00[Asia/Singapore]\n'
    + 'Browser time zone for this request: Asia/Singapore. Interpret otherwise-unqualified dates and times in this zone.\n'
    + 'Elapsed since the preceding step context: 1m 2s.',
  )
  const same = tracker.resolveTurnIdentity('time-context', [prompt, timeSnapshot])
  assert.equal(same.businessId, first.businessId)
  const next = tracker.resolveTurnIdentity('time-context', [prompt, timeSnapshot,
    wireUser('Time sampled while preparing turn means what?')])
  assert.notEqual(next.businessId, first.businessId)
  assert.equal(next.businessName, 'Time sampl')
})
