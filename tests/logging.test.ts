import test from 'node:test'
import assert from 'node:assert/strict'
import {
  logParsedResponse,
  redactLogPayload,
  redactLogValue,
} from '../src/qoder/transport/logging.ts'

test('Qoder diagnostics redact credentials and subscriber identifiers while preserving useful fields', () => {
  const redacted = redactLogValue({
    id: 'user-123456',
    email: 'subscriber@example.com',
    authorization: 'Bearer jt-secret-token',
    nested: {
      personal_token: 'pt-personal-secret',
      unit: 'credits',
      remaining: 42,
    },
  })
  const output = JSON.stringify(redacted)
  assert.doesNotMatch(output, /user-123456|subscriber@example\.com|jt-secret-token|pt-personal-secret/)
  assert.match(output, /credits/)
  assert.match(output, /42/)
})

test('Qoder diagnostics redact token-like values in JSON and plain-text payloads', () => {
  assert.doesNotMatch(JSON.stringify(redactLogPayload('{"token":"jt-json-secret"}')), /jt-json-secret/)
  assert.doesNotMatch(String(redactLogPayload('upstream rejected pt-plain-secret')), /pt-plain-secret/)
})

test('parsed response logging uses one event shape and redacts its result', () => {
  const entries: Array<{ message: string; details: unknown }> = []
  logParsedResponse({
    debug: (message, details) => entries.push({ message, details }),
  }, 'auth.exchange', {
    token: 'jt-parsed-secret',
    expires_in: 3_600_000,
  })

  assert.equal(entries[0]?.message, '[Qoder Response] Parsed')
  assert.deepEqual(entries[0]?.details, {
    operation: 'auth.exchange',
    result: {
      token: '[REDACTED]',
      expires_in: 3_600_000,
    },
  })
})
