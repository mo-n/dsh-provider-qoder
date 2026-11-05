import assert from 'node:assert/strict'
import test from 'node:test'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { prepareQoderRequest } from '../src/qoder/transport/wire/prepare.ts'
import { QoderTurnTracker } from '../src/qoder/transport/wire/turn-identity.ts'

test('parallel no-session calls aggregate only within the same subscriber, region and model', async () => {
  const tracker = new QoderTurnTracker({ now: () => 1_000 })
  const prepare = (subscriber = 'parallel-user', region = 'global', model = 'review-model') => {
    const options: GenerateOptions = { provider: 'dsh-provider-qoder', model, messages: [] }
    return prepareQoderRequest(options, subscriber, [{ role: 'user', content: 'Review this action' }],
      undefined, undefined, tracker, region)
  }
  const [first, same, anotherUser, anotherRegion, anotherModel] = await Promise.all([
    prepare(), prepare(), prepare('other-user'), prepare('parallel-user', 'china'),
    prepare('parallel-user', 'global', 'other-model'),
  ])
  assert.equal(first.sessionId, same.sessionId)
  assert.equal(first.requestSetId, same.requestSetId)
  assert.equal(first.business.id, same.business.id)
  assert.equal(first.business.stage, 'start')
  assert.equal(same.business.stage, 'processing')
  assert.notEqual(first.requestId, same.requestId)
  assert.equal(first.chatRecordId, first.requestId)
  assert.equal(same.chatRecordId, same.requestId)
  for (const separate of [anotherUser, anotherRegion, anotherModel]) {
    assert.notEqual(separate.sessionId, first.sessionId)
    assert.notEqual(separate.requestSetId, first.requestSetId)
    assert.notEqual(separate.business.id, first.business.id)
  }
})

// New DSH hosts send this purpose; the pinned older host types do not yet list it.
const reviewPurpose = 'auto-review' as GenerateOptions['purpose']

test('session-attributed auto review uses a separate fixed window without displacing the host turn', async () => {
  let now = 1_000
  const tracker = new QoderTurnTracker({ now: () => now })
  const hostRun = { id: 'review-host-turn' }
  const base: GenerateOptions = {
    provider: 'dsh-provider-qoder', model: 'review-model', messages: [],
    sessionId: 'review-session' as GenerateOptions['sessionId'],
  }
  const prepare = (purpose: GenerateOptions['purpose'], text: string, session = base.sessionId) =>
    prepareQoderRequest({ ...base, sessionId: session, purpose }, 'review-subscriber',
      [{ role: 'user', content: text }], undefined, undefined, tracker, 'global', hostRun)
  const main = await prepare(undefined, 'Fix the source')
  const first = await prepare(reviewPurpose, 'Review read')
  now += 60_000
  const same = await prepare(reviewPurpose, 'Review edit')
  assert.equal(first.business.id, same.business.id)
  assert.equal(first.requestSetId, same.requestSetId)
  assert.equal(first.business.begin_at, same.business.begin_at)
  assert.equal(same.business.stage, 'processing')
  assert.notEqual(first.requestId, same.requestId)
  assert.equal(first.sessionId, main.sessionId)
  assert.notEqual(first.business.id, main.business.id)
  assert.notEqual(first.requestSetId, main.requestSetId)
  const resumed = await prepare(undefined, 'Fix the source')
  assert.equal(resumed.business.id, main.business.id)
  const otherSession = await prepare(reviewPurpose, 'Review edit', 'other-session' as GenerateOptions['sessionId'])
  assert.notEqual(otherSession.business.id, first.business.id)
  assert.notEqual(otherSession.sessionId, first.sessionId)
  for (const purpose of ['compaction', 'session-title'] as const) {
    const a = await prepare(purpose, 'Summarize')
    const b = await prepare(purpose, 'Summarize')
    assert.notEqual(a.business.id, b.business.id)
  }
  now = 1_000 + 5 * 60 * 1_000
  const expired = await prepare(reviewPurpose, 'Review next')
  assert.equal(expired.sessionId, first.sessionId)
  assert.notEqual(expired.business.id, first.business.id)
  assert.notEqual(expired.requestSetId, first.requestSetId)
  assert.equal(first.business.stage, 'start')
  assert.equal(first.business.begin_at, 1_000)
})

test('auto review without a host run or session still aggregates and stays separate from ordinary calls', async () => {
  const tracker = new QoderTurnTracker({ now: () => 1_000 })
  const prepare = (purpose?: GenerateOptions['purpose'], sessionId?: GenerateOptions['sessionId']) =>
    prepareQoderRequest({ provider: 'qoder', model: 'review-model', messages: [], purpose, sessionId },
      'review-subscriber', [{ role: 'user', content: 'Review action' }], undefined, undefined, tracker, 'global')
  for (const session of [undefined, 'standalone-review' as GenerateOptions['sessionId']]) {
    const first = await prepare(reviewPurpose, session)
    const same = await prepare(reviewPurpose, session)
    const ordinary = await prepare(undefined, session)
    assert.equal(first.business.id, same.business.id)
    assert.equal(first.requestSetId, same.requestSetId)
    assert.equal(first.sessionId, same.sessionId)
    assert.notEqual(first.business.id, ordinary.business.id)
    assert.notEqual(first.requestSetId, ordinary.requestSetId)
  }
})
