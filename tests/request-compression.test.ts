import test from 'node:test'
import assert from 'node:assert/strict'
import { zstdDecompressSync } from 'node:zlib'
import { QoderRequestCompression, compressionRejection } from '../src/qoder/transport/request-compression.ts'
import { QoderLlmError } from '../src/qoder/errors.ts'
import { createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { streamModelServerChat } from '../src/qoder/transport/model-server.ts'
import { streamQoderChat } from '../src/qoder/transport/chat.ts'
import { qoderEncodeBodyBytes } from '../src/qoder/transport/wire/encoding.ts'
import { Config } from '../src/dsh/config.ts'

const body = JSON.stringify({ messages: [{ role: 'user', content: '历史 history '.repeat(2000) }] })
let endpoint = 0
function options(protocol: 'http' | 'legacy' = 'http') {
  return {
    url: `https://compression-${++endpoint}.example/model`, protocol, body, enabled: true,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test', 'Content-Length': '100' },
    signal: new AbortController().signal, requestId: 'test-request',
  }
}

test('Zstd preserves complete UTF-8 JSON and removes stale content length', async () => {
  const args = options()
  await new QoderRequestCompression().send({ ...args, dispatch: async (wire, headers) => {
    assert.ok(wire instanceof Uint8Array)
    assert.equal(zstdDecompressSync(wire).toString('utf8'), body)
    assert.ok(wire.byteLength < Buffer.byteLength(body))
    assert.equal(headers['Content-Encoding'], 'zstd')
    assert.equal(headers.Authorization, 'Bearer test')
    assert.ok(!('Content-Length' in headers))
    return new Response('ok')
  } })
})

test('compression sends identity when the caller leaves its setting unspecified', async () => {
  const { enabled: _enabled, ...args } = options()
  await new QoderRequestCompression().send({ ...args, dispatch: async (wire, headers) => {
    assert.equal(wire, body)
    assert.equal(new Headers(headers).get('content-encoding'), null)
    return new Response('ok')
  } })
})

test('small, disabled, VPC and pre-encoded requests send identity', async () => {
  for (const override of [{ body: 'small' }, { enabled: false },
    { url: 'https://team.vpc.qoder.com.cn/model' },
    { headers: { 'Content-Encoding': 'gzip' } }]) {
    const args = { ...options(), ...override }
    await new QoderRequestCompression().send({ ...args, dispatch: async wire => {
      assert.equal(wire, args.body)
      return new Response('ok')
    } })
  }
})

test('every identity dispatch reports its byte count and skip reason', async () => {
  const compression = new QoderRequestCompression()
  const logs: unknown[][] = []
  await compression.send({ ...options(), enabled: false,
    logger: { debug: (...details) => logs.push(details) },
    dispatch: async () => new Response('ok'),
  })
  assert.deepEqual(compression.diagnostics, {
    encoding: 'identity', originalBytes: Buffer.byteLength(body), sentBytes: Buffer.byteLength(body), reason: 'disabled',
  })
  assert.equal(logs[0][0], '[Qoder Request] Dispatch')
})

test('only qodercli compression-specific rejections qualify', () => {
  assert.equal(compressionRejection(415, 'unsupported zstd', 'http'), 'unsupported_encoding')
  assert.equal(compressionRejection(415, 'unsupported image', 'http'), undefined)
  assert.equal(compressionRejection(400, "invalid character '(' in JSON", 'http'), 'invalid_json_at_origin')
  assert.equal(compressionRejection(400, 'invalid JSON field', 'http'), undefined)
  const signature = '{"code":101,"message":"signature is invalid"}'
  assert.equal(compressionRejection(403, signature, 'legacy'), 'signature_invalid')
  assert.equal(compressionRejection(403, signature, 'http'), undefined)
  assert.equal(compressionRejection(403, '{"code":105,"message":"signature invalid"}', 'legacy'), undefined)
  assert.equal(compressionRejection(500, 'zstd content-encoding error', 'http'), undefined)
})

test('HTTP falls back once and remembers endpoint only after model confirmation', async () => {
  const args = options()
  const first = new QoderRequestCompression()
  let count = 0
  await first.send({ ...args, dispatch: async (wire, headers) => {
    if (++count === 1) {
      assert.ok(wire instanceof Uint8Array)
      return new Response('unsupported zstd', { status: 415 })
    }
    assert.equal(wire, body)
    assert.ok(!('Content-Encoding' in headers))
    return new Response('ok')
  } })
  assert.equal(count, 2)
  const check = async (expectedCompressed: boolean, url = args.url, protocol: 'http' | 'legacy' = 'http') => {
    await new QoderRequestCompression().send({ ...args, url, protocol, dispatch: async wire => {
      assert.equal(wire instanceof Uint8Array, expectedCompressed)
      return new Response('ok')
    } })
  }
  await check(true)
  first.confirm()
  await check(false)
  await check(false, args.url + '?different=query')
  await check(true, args.url + '/other')
  await check(true, args.url, 'legacy')
})

test('ordinary rejection and network failure never replay automatically', async () => {
  for (const status of [400, 401, 403, 415, 500]) {
    let calls = 0
    const response = await new QoderRequestCompression().send({ ...options(), dispatch: async () => {
      calls++
      return new Response('generic error', { status })
    } })
    assert.equal(response.status, status)
    assert.equal(calls, 1)
  }
  let calls = 0
  await assert.rejects(new QoderRequestCompression().send({ ...options(), dispatch: async () => {
    calls++
    throw new Error('network failure')
  } }), /network failure/u)
  assert.equal(calls, 1)
})

test('a failed identity fallback is not replayed or remembered as a working endpoint', async () => {
  const args = options()
  let calls = 0
  const response = await new QoderRequestCompression().send({ ...args, dispatch: async () => {
    calls++
    return calls === 1 ? new Response('unsupported zstd', { status: 415 })
      : new Response('failed', { status: 500 })
  } })
  assert.equal(response.status, 500)
  assert.equal(calls, 2)
  await new QoderRequestCompression().send({ ...args, dispatch: async wire => {
    assert.ok(wire instanceof Uint8Array)
    return new Response('ok')
  } })
})

test('cancellation interrupts a stalled compression-rejection probe without replay', async () => {
  const controller = new AbortController()
  let calls = 0
  const operation = new QoderRequestCompression().send({ ...options(), signal: controller.signal,
    dispatch: async () => {
      calls++
      setTimeout(() => controller.abort(), 10)
      return new Response(new ReadableStream(), { status: 415 })
    },
  })
  await assert.rejects(operation, { name: 'AbortError' })
  assert.equal(calls, 1)
})

test('legacy disables compression and delegates retry with new identity to DSH', async () => {
  const args = options('legacy')
  let calls = 0
  await assert.rejects(new QoderRequestCompression().send({ ...args, dispatch: async () => {
    calls++
    return new Response('{"code":101,"message":"signature invalid"}', { status: 403 })
  } }), (error: unknown) => error instanceof QoderLlmError && error.code === 'TRANSPORT')
  assert.equal(calls, 1)
  await new QoderRequestCompression().send({ ...args, dispatch: async wire => {
    assert.equal(wire, body)
    return new Response('ok')
  } })
})

test('legacy SSE encoding rejection delegates recovery only while unconfirmed', async () => {
  const args = options('legacy')
  const compression = new QoderRequestCompression()
  await compression.send({ ...args, dispatch: async () => new Response('stream') })
  const error = new QoderLlmError('signature invalid', 'PROVIDER_ERROR', {
    status: 403, cause: '{"code":101,"message":"signature invalid"}',
  })
  assert.throws(() => compression.rejectLegacyError(error),
    (error: unknown) => error instanceof QoderLlmError && error.code === 'TRANSPORT')
  const confirmed = new QoderRequestCompression()
  await confirmed.send({ ...options('legacy'), dispatch: async () => new Response('stream') })
  confirmed.confirm()
  assert.doesNotThrow(() => confirmed.rejectLegacyError(error))
})

test('already cancelled requests never dispatch', async () => {
  await assert.rejects(new QoderRequestCompression().send({
    ...options(), signal: AbortSignal.abort(), dispatch: async () => { throw new Error('unexpected dispatch') },
  }), { name: 'AbortError' })
})

test('CLI threshold and level tuning preserves the provider compression switch', async () => {
  const keys = ['QODER_ZSTD_REQUEST_BODY_MIN_CHARS', 'QODER_ZSTD_REQUEST_BODY_LEVEL']
  const saved = keys.map(key => process.env[key])
  try {
    await new QoderRequestCompression().send({ ...options(), enabled: false, dispatch: async wire => {
      assert.equal(wire, body)
      return new Response('ok')
    } })
    process.env.QODER_ZSTD_REQUEST_BODY_MIN_CHARS = '1'
    process.env.QODER_ZSTD_REQUEST_BODY_LEVEL = '999'
    await new QoderRequestCompression().send({ ...options(), enabled: true, body: 'a'.repeat(1000), dispatch: async wire => {
      assert.ok(wire instanceof Uint8Array)
      assert.equal(zstdDecompressSync(wire).toString(), 'a'.repeat(1000))
      return new Response('ok')
    } })
    assert.equal(Config({}).requestCompression, false)
    assert.equal(Config({ requestCompression: true }).requestCompression, true)
  } finally {
    keys.forEach((key, index) => {
      if (saved[index] === undefined) delete process.env[key]
      else process.env[key] = saved[index]
    })
  }
})

test('HTTP compresses history exceeding 256 KiB and keeps identity across authentication recovery', async () => {
  const request: GenerateOptions = {
    provider: 'dsh-provider-qoder', model: 'cmodel',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'large history '.repeat(25000) }], source: { kind: 'user' } })],
  }
  const credentials = { userID: 'compression-user', authToken: 'old', name: '', email: '' }
  const ids: string[] = []
  let refreshes = 0
  const text: string[] = []
  for await (const chunk of streamModelServerChat(request, undefined, credentials,
    [{ role: 'user', content: 'large history '.repeat(25000) }], {
      requestCompression: true, region: 'global', responseHeaderTimeoutMs: 1000, streamIdleTimeoutMs: 1000,
      refreshCredentials: async () => { refreshes++; return { ...credentials, authToken: 'new' } },
      fetch: (async (_url, init) => {
        const headers = new Headers(init?.headers)
        assert.equal(headers.get('content-encoding'), 'zstd')
        const decoded = zstdDecompressSync(init?.body as Uint8Array)
        assert.ok(decoded.byteLength > 262144)
        const payload = JSON.parse(decoded.toString())
        ids.push(payload.metadata.context.request_id)
        if (ids.length === 1) return new Response('{}', { status: 401 })
        assert.equal(headers.get('authorization'), 'Bearer new')
        return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      }) as typeof fetch,
    })) if (chunk.type === 'text-delta') text.push(chunk.text)
  assert.equal(text.join(''), 'ok')
  assert.equal(refreshes, 1)
  assert.equal(ids.length, 2)
  assert.equal(ids[0], ids[1])
})

test('HTTP failures report encoding metadata without request or response contents', async () => {
  const logs: unknown[][] = []
  const request: GenerateOptions = { provider: 'dsh-provider-qoder', model: 'cmodel', messages: [] }
  const upstream = '{"detail":"upstream processing failed"}'
  await assert.rejects(async () => {
    for await (const _chunk of streamModelServerChat(request, undefined,
      { userID: 'capture-user', authToken: 'never-save-this-token', name: '', email: '' },
      [{ role: 'user', content: 'long history '.repeat(2000) }], {
        requestCompression: true, region: 'global', responseHeaderTimeoutMs: 1000, streamIdleTimeoutMs: 1000,
        logger: { warn: (...details) => logs.push(details) },
        refreshCredentials: async () => { throw new Error('unexpected authentication recovery') },
        fetch: (async () => new Response(upstream, { status: 500, headers: { 'content-type': 'application/json' } })) as typeof fetch,
      })) continue
  }, (error: unknown) => error instanceof QoderLlmError && error.code === 'SERVER')
  const rejection = logs.find(entry => entry[0] === '[Qoder Stream] HTTP request rejected')?.[1] as {
    status: number; request: { encoding: string; sentBytes: number; originalBytes: number }
  }
  assert.equal(rejection.status, 500)
  assert.equal(rejection.request.encoding, 'zstd')
  assert.ok(rejection.request.sentBytes < rejection.request.originalBytes)
  assert.doesNotMatch(JSON.stringify(logs), /never-save-this-token|long history|upstream processing failed|requestPath|responsePath/u)
})

test('legacy compresses WAF bytes and returns a DSH-retryable pre-output SSE rejection', async () => {
  const request: GenerateOptions = { provider: 'dsh-provider-qoder', model: 'cmodel', messages: [] }
  let calls = 0
  const credentials = { userID: 'compression-user', authToken: 'test', name: '', email: '' }
  await assert.rejects(async () => {
    for await (const _chunk of streamQoderChat(request, undefined, credentials,
      [{ role: 'user', content: 'history '.repeat(2000) }], {
        requestCompression: true, region: 'china', responseHeaderTimeoutMs: 1000, streamIdleTimeoutMs: 1000,
        fetch: (async (_url, init) => {
          calls++
          assert.equal(new Headers(init?.headers).get('content-encoding'), 'zstd')
          const encoded = zstdDecompressSync(init?.body as Uint8Array)
          // WAF body is ASCII, not plaintext JSON, and has the codec's padding.
          assert.ok(!encoded.toString().startsWith('{'))
          assert.ok(encoded.byteLength > qoderEncodeBodyBytes('{}').byteLength)
          return new Response(`data: ${JSON.stringify({ statusCodeValue: 403, body: '{"code":101,"message":"signature invalid"}' })}\n\n`)
        }) as typeof fetch,
      })) continue
  }, (error: unknown) => error instanceof QoderLlmError && error.code === 'TRANSPORT')
  assert.equal(calls, 1)
})

test('compression rejection callback preserves a bounded original response before fallback', async () => {
  const args = options()
  const captured: unknown[] = []
  const errorBody = "invalid character '(' parsing JSON: " + 'x'.repeat(9000)
  let calls = 0
  await new QoderRequestCompression().send({ ...args,
    onRejection: async rejection => { captured.push(rejection) },
    dispatch: async () => {
      if (++calls === 1) return new Response(errorBody, { status: 400 })
      assert.equal(captured.length, 1)
      return new Response('ok')
    },
  })
  assert.equal(calls, 2)
  assert.deepEqual(captured[0], {
    status: 400, contentType: 'text/plain;charset=UTF-8', serverRequestId: undefined,
    body: errorBody.slice(0, 8192), bodyTruncated: true, probeTimedOut: false,
    reason: 'invalid_json_at_origin',
  })
})

test('failed diagnostic capture does not prevent identity recovery', async () => {
  let calls = 0
  const response = await new QoderRequestCompression().send({ ...options(),
    onRejection: async () => { throw new Error('disk unavailable') },
    dispatch: async () => ++calls === 1 ? new Response('unsupported zstd', { status: 415 }) : new Response('ok'),
  })
  assert.equal(response.status, 200)
  assert.equal(calls, 2)
})

// Compression capability is remembered per endpoint; keep these cases independent.
for (const { fallbackStatus, region } of [
  { fallbackStatus: 500, region: 'global' },
  { fallbackStatus: 200, region: 'china' },
] as const) {
  test(`HTTP identity headers and first compression error survive fallback status ${fallbackStatus}`, async () => {
    const logs: unknown[][] = []
    const rejectionBody = '{"error":"invalid character \'(\' looking for beginning of value"}'
    const request: GenerateOptions = { provider: 'dsh-provider-qoder', model: 'cmodel', messages: [] }
    let calls = 0
    const operation = async () => {
      for await (const _chunk of streamModelServerChat(request, undefined,
        { userID: 'first-rejection-user', authToken: 'do-not-capture-authorization', name: '', email: '' },
        [{ role: 'user', content: 'history '.repeat(2000) }], {
          requestCompression: true, region, responseHeaderTimeoutMs: 1000, streamIdleTimeoutMs: 1000,
          logger: { warn: (...details) => logs.push(details), debug: (...details) => logs.push(details) },
          refreshCredentials: async () => { throw new Error('unexpected refresh') },
          fetch: (async (_url, init) => {
            const headers = new Headers(init?.headers)
            assert.equal(headers.get('authorization'), 'Bearer do-not-capture-authorization')
            assert.equal(headers.get('cosy-version'), '1.1.73')
            assert.equal(headers.get('cosy-clienttype'), '5')
            assert.ok(headers.get('cosy-machineos'))
            assert.equal(headers.get('cosy-key'), null)
            if (++calls === 1) {
              assert.equal(headers.get('content-encoding'), 'zstd')
              return new Response(rejectionBody, { status: 400, headers: { 'content-type': 'application/json', 'x-request-id': 'original-400' } })
            }
            assert.ok(logs.some(entry => entry[0] === '[Qoder Stream] Compression rejected'))
            assert.equal(headers.get('content-encoding'), null)
            return fallbackStatus === 500 ? new Response('{"error":"internal server error"}', { status: 500 })
              : new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
          }) as typeof fetch,
        })) continue
    }
    if (fallbackStatus === 500) await assert.rejects(operation, /HTTP 500/u)
    else await operation()
    assert.equal(calls, 2)
    const original = logs.find(entry => entry[0] === '[Qoder Stream] Compression rejected')?.[1] as {
      status: number; serverRequestId: string; reason: string; bodyTruncated: boolean; request: { encoding: string }
    }
    assert.equal(original.status, 400)
    assert.equal(original.serverRequestId, 'original-400')
    assert.equal(original.reason, 'invalid_json_at_origin')
    assert.equal(original.bodyTruncated, false)
    assert.equal(original.request.encoding, 'zstd')
    if (fallbackStatus === 500) {
      const final = logs.find(entry => entry[0] === '[Qoder Stream] HTTP request rejected')?.[1] as {
        status: number; request: { encoding: string }
      }
      assert.equal(final.status, 500)
      assert.equal(final.request.encoding, 'identity')
    }
    assert.doesNotMatch(JSON.stringify(logs), /do-not-capture-authorization|history history|internal server error|requestPath|responsePath/u)
  })
}
