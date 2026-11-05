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
