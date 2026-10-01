import test from 'node:test'
import assert from 'node:assert/strict'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { QoderLlmError, qoderHttpError, qoderModelError, canRefreshModelCredentials, retryAfterMs } from '../src/qoder/errors.ts'

test('QoderLlmError is a structured DSH LlmError', () => {
  const error = new QoderLlmError('unavailable', 'SERVER', { status: 503 })
  assert.ok(error instanceof LlmError)
  assert.deepEqual(error.failure, { message: 'unavailable', code: 'SERVER', status: 503 })
})

test('qoderHttpError maps HTTP status classes to DSH error codes', () => {
  const cases = [
    [400, 'INVALID_REQUEST'],
    [401, 'AUTH'],
    [403, 'AUTH'],
    [408, 'TIMEOUT'],
    [429, 'RATE_LIMIT'],
    [500, 'SERVER'],
    [503, 'SERVER'],
  ] as const
  for (const [status, code] of cases) {
    const error = qoderHttpError(`HTTP ${status}`, new Response(null, { status }))
    assert.equal(error.code, code)
    assert.equal(error.failure.status, status)
  }
})

test('retryAfterMs accepts delay-seconds and future HTTP dates', () => {
  const now = Date.parse('2026-09-03T00:00:00Z')
  assert.equal(retryAfterMs('3', now), 3000)
  assert.equal(retryAfterMs('Wed, 03 Sep 2026 00:00:05 GMT', now), 5000)
  assert.equal(retryAfterMs('0', now), undefined)
  assert.equal(retryAfterMs('invalid', now), undefined)
  assert.equal(retryAfterMs('Wed, 02 Sep 2026 00:00:00 GMT', now), undefined)
})

test('qoderHttpError preserves an upstream request id', () => {
  const error = qoderHttpError('unavailable', {
    status: 503,
    headers: new Headers({ 'x-request-id': 'request-42' }),
  })
  assert.equal(error.failure.requestId, 'request-42')
})

for (const [upstreamCode, code] of [
  ['103', 'PROVIDER_ERROR'], ['105', 'AUTH'], ['110', 'QUOTA'], ['112', 'QUOTA'],
  ['114', 'QUOTA'], ['115', 'QUOTA'], ['116', 'QUOTA'], ['117', 'QUOTA'],
  ['119', 'QUOTA'], ['122', 'QUOTA'], ['406', 'PROVIDER_ERROR'],
  ['416', 'INVALID_REQUEST'], ['430', 'INVALID_REQUEST'], ['10605', 'RATE_LIMIT'],
  ['100400', 'PROVIDER_ERROR'], ['100401', 'AUTH'], ['100403', 'PROVIDER_ERROR'],
] as const) {
  test(`model business code ${upstreamCode} overrides forbidden status as ${code}`, () => {
    for (const value of [upstreamCode, Number(upstreamCode)]) {
      const error = qoderModelError('rejected', { status: 403, source: 'http', cause: { code: value } })
      assert.equal(error.code, code)
      assert.equal(error.upstreamCode, upstreamCode)
      assert.equal(canRefreshModelCredentials(error), upstreamCode === '105')
      assert.equal(error.failure.status, 403)
    }
  })
}

test('nested business codes override wrapper status and all sibling diagnostic paths are inspected', () => {
  const cause = JSON.stringify({ code: '403', message: 'not JSON', details: JSON.stringify({
    error: { error_code: 112, message: JSON.stringify({ pricingUrl: 'https://qoder.com.cn/pricing' }) },
  }) })
  const error = qoderModelError('rejected', { status: 403, source: 'sse', httpStatus: 200, cause })
  assert.equal(error.code, 'QUOTA')
  assert.equal(error.upstreamCode, '112')
  assert.match(error.message, /personal Credits/)
  assert.equal(error.cause, cause)
  assert.equal(error.httpStatus, 200)
  assert.equal(canRefreshModelCredentials(error), false)
})

test('model queues preserve the longer delay without requiring isQueued or clamping to the DSH cap', () => {
  const error = qoderModelError('rejected', {
    status: 403, source: 'http', headers: new Headers({ 'retry-after': '60', 'x-request-id': 'queue-id' }),
    cause: { code: '10605', message: JSON.stringify({ retryAfterSeconds: 30 }) },
  })
  assert.equal(error.code, 'RATE_LIMIT')
  assert.equal(error.failure.providerRetryAfterMs, 60_000)
  assert.equal(error.failure.requestId, 'queue-id')
  for (const retryAfterSeconds of [undefined, 0, -1, '30', Infinity, Number.MAX_VALUE]) {
    const invalid = qoderModelError('rejected', { status: 403, source: 'http', cause: { code: 10605, retryAfterSeconds } })
    assert.equal(invalid.code, 'RATE_LIMIT')
    assert.equal(invalid.failure.providerRetryAfterMs, undefined)
  }
})

test('unknown explicit model codes suppress credential recovery and text guesses', () => {
  for (const code of ['99999', 'expired', 'toString']) {
    const error = qoderModelError('rejected', { status: 403, source: 'http', cause: { code, message: 'User quota exhausted' } })
    assert.equal(error.code, 'PROVIDER_ERROR')
    assert.equal(canRefreshModelCredentials(error), false)
  }
  for (const cause of ['forbidden', '{invalid', { code: 403, message: 'forbidden' }]) {
    assert.equal(canRefreshModelCredentials(qoderModelError('rejected', { status: 403, source: 'http', cause })), true)
  }
})

test('model text fallback distinguishes context and quota from bare business-code digits', () => {
  for (const [cause, code] of [
    ['User quota exhausted', 'QUOTA'], ['context_length_exceeded', 'CONTEXT_WINDOW_EXCEEDED'],
    ['Request 112 had 10605 tokens', 'AUTH'],
  ]) assert.equal(qoderModelError('rejected', { status: 403, source: 'http', cause }).code, code)
})

test('model text signals survive sibling diagnostics and display truncation', () => {
  for (const source of ['http', 'sse'] as const) {
    for (const [message, expected] of [
      ['User quota exhausted', 'QUOTA'],
      ['context_length_exceeded', 'CONTEXT_WINDOW_EXCEEDED'],
    ]) {
      for (const prefix of ['', 'diagnostic '.repeat(40)]) {
        const cause = JSON.stringify({ message: prefix + message, details: 'contact support' })
        const error = qoderModelError('rejected', { status: 403, source, cause })
        assert.equal(error.code, expected)
        assert.equal(canRefreshModelCredentials(error), false)
      }
    }
    for (const cause of [
      { message: 'User quota exhausted', details: 'context_length_exceeded' },
      { message: 'context_length_exceeded', details: 'User quota exhausted' },
    ]) {
      assert.equal(qoderModelError('rejected', { status: 403, source, cause }).code, 'CONTEXT_WINDOW_EXCEEDED')
      assert.equal(qoderModelError('rejected', { status: 403, source, cause: { ...cause, code: 105 } }).code, 'AUTH')
    }
  }
})

test('model rate limits without business codes preserve the greater valid body and header delay', () => {
  for (const source of ['http', 'sse'] as const) {
    for (const [retryAfterSeconds, header, expected] of [
      [30, '1', 30_000], [30, '60', 60_000], [30, undefined, 30_000],
      [undefined, '1', 1000], [0, '1', 1000], [-1, '1', 1000],
      ['30', '1', 1000], [Number.MAX_VALUE, '1', 1000], [undefined, undefined, undefined],
    ] as const) {
      const error = qoderModelError('rejected', {
        status: 429, source,
        headers: new Headers(header === undefined ? {} : { 'retry-after': header }),
        cause: { message: 'busy', retryAfterSeconds },
      })
      assert.equal(error.code, 'RATE_LIMIT')
      assert.equal(error.failure.providerRetryAfterMs, expected)
      assert.equal(canRefreshModelCredentials(error), false)
    }
  }
})

test('model diagnostic traversal handles cycles and excessive nested JSON safely', () => {
  const cause: Record<string, unknown> = { code: '10605' }
  cause.message = cause
  assert.equal(qoderModelError('rejected', { status: 403, source: 'http', cause }).code, 'RATE_LIMIT')
  let nested: unknown = { code: '112' }
  for (let i = 0; i < 20; i++) nested = { message: JSON.stringify(nested) }
  assert.equal(qoderModelError('rejected', { status: 403, source: 'http', cause: nested }).code, 'AUTH')
})
