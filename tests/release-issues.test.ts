import test from 'node:test'
import assert from 'node:assert/strict'
import { closeReleaseIssues, hasClosingReference, linkedIssues } from '../scripts/release-issues.ts'

test('release links are explicit local references limited to the Linked Issue section', () => {
  assert.deepEqual(linkedIssues(`Ref #99
### Linked Issue
<!-- Ref #88 -->
Refs #123, #124
- Ref: #125 and #123
Fix #126
Ref owner/other#127
See #128 for background
Ref #
### Description
Ref #129`), ['123', '124', '125', '126'])
})

test('all GitHub closing keyword variants are rejected, including external references', () => {
  for (const keyword of ['fix', 'fixes', 'fixed', 'close', 'closes', 'closed', 'resolve', 'resolves', 'resolved']) {
    for (const ref of ['#123', 'owner/repo#123', 'https://github.com/owner/repo/issues/123']) {
      assert.equal(hasClosingReference(`${keyword.toUpperCase()}: ${ref}`), true)
    }
  }
  assert.equal(hasClosingReference('Refs #123, #124'), false)
  assert.equal(hasClosingReference('fix(qoder): preserve image results'), false)
})

test('release processing scopes PRs, deduplicates issues and skips already closed issues', () => {
  const calls: string[][] = []
  closeReleaseIssues('owner/repo', 'v1.0.0', (args) => {
    calls.push(args)
    if (args[0] === 'release') return JSON.stringify({ body: 'https://github.com/owner/repo/pull/1 https://github.com/owner/repo/pull/1 https://github.com/other/repo/pull/2' })
    if (args[0] === 'pr') return JSON.stringify({ body: '### Linked Issue\nRefs #10, #11, #10\n### Description\nRef #12' })
    if (args[1] === 'view') return JSON.stringify({ state: args[2] === '11' ? 'CLOSED' : 'OPEN' })
    return ''
  })
  assert.equal(calls.filter(args => args[0] === 'pr').length, 1)
  const closes = calls.filter(args => args[1] === 'close')
  assert.equal(closes.length, 1)
  assert.equal(closes[0][2], '10')
  assert.match(closes[0].at(-1)!, /releases\/tag\/v1\.0\.0/)
})

test('PR and closure failures are reported after other issues are processed', () => {
  const closed: string[] = []
  assert.throws(() => closeReleaseIssues('owner/repo', 'v1', (args) => {
    if (args[0] === 'release') return JSON.stringify({ body: 'https://github.com/owner/repo/pull/1 https://github.com/owner/repo/pull/2' })
    if (args[0] === 'pr') {
      if (args[2] === '1') throw new Error('PR read denied')
      return JSON.stringify({ body: '### Linked Issue\nRefs #10, #11' })
    }
    if (args[1] === 'view') return JSON.stringify({ state: 'OPEN' })
    if (args[2] === '10') throw new Error('close denied')
    closed.push(args[2])
    return ''
  }), (error: Error) => {
    assert.match(error.message, /PR #1: Error: PR read denied/)
    assert.match(error.message, /Issue #10: Error: close denied/)
    return true
  })
  assert.deepEqual(closed, ['11'])
})

test('release lookup failures fail the operation', () => {
  assert.throws(() => closeReleaseIssues('owner/repo', 'v1', () => { throw new Error('release unavailable') }), /release unavailable/)
})
