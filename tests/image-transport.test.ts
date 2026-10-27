import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import type { IncomingMessage } from 'node:http'
import http from 'node:http'
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'
import type { RequestOptions, request as httpsRequest } from 'node:https'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { searchImages, generateImage, imageToolUrl, pinnedDownload, type ImageToolDependencies } from '../src/qoder/transport/image-tools.ts'
import { QoderImageDeliveryError, QoderImageSearchError } from '../src/qoder/images.ts'
import { QoderLlmError } from '../src/qoder/errors.ts'
import { imageFailureDetails } from '../src/qoder/images.ts'
import { imageResponseDiagnostic, inspectImageUrl } from '../src/qoder/transport/image-diagnostics.ts'
import { qoderEncodeBody } from '../src/qoder/transport/wire/encoding.ts'
import { computeSigPath } from '../src/qoder/transport/wire/cosy.ts'
import { prepareQoderRequest } from '../src/qoder/transport/wire/prepare.ts'
import { createQoderTransport } from '../src/qoder/transport/index.ts'
const creds = { userID: 'fixture-user', authToken: 'fixture-token', name: 'Fixture', email: '', machineID: 'fixture-machine' }
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')

test('returned image response diagnostics expose URL rejection without signed or echoed content', async () => {
  for (const [url, rejection] of [
    ['ftp://images.example.com/private?signature=secret', 'UNSUPPORTED_PROTOCOL'],
    ['https://user:secret@images.example.com/private', 'URL_CREDENTIALS'],
    ['https://host/private', 'UNQUALIFIED_HOST'],
    ['https://host.internal/private', 'LOCAL_HOST'],
    ['data:image/png,secret', 'INVALID_DATA_URL'],
    ['not a URL secret', 'INVALID_URL'],
  ]) {
    const logs: unknown[] = []
    let calls = 0
    const deps = dependencies((async () => { calls++; return json({ code: 200, data: [{ url }], message: 'secret', token: 'secret' }) }) as typeof fetch)
    deps.logger = { debug: (message, details) => logs.push({ message, details }), warn: (message, details) => logs.push({ message, details }) }
    await assert.rejects(generateImage({ prompt: 'secret' }, deps), QoderImageDeliveryError)
    assert.equal(calls, 1)
    assert.equal(inspectImageUrl(url).rejection, rejection)
    const serialized = JSON.stringify(logs)
    assert.ok(serialized.includes('Generation response body'))
    assert.ok(serialized.includes(rejection))
    assert.ok(!serialized.includes('private'))
    assert.ok(!serialized.includes('secret'))
  }
  const result = imageResponseDiagnostic({ code: '200', data: [{ url: 'https://images.example.com/private?signature=secret', b64_json: 'secret' }], message: 'https://host/private?secret', nested: { password: 'secret' } })
  assert.ok(!JSON.stringify(result).includes('secret'))
  assert.ok(JSON.stringify(result).includes('images.example.com'))
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic
  assert.ok(JSON.stringify(imageResponseDiagnostic(cyclic)).includes('[TRUNCATED]'))
})

test('image diagnostics correlate phases and redact signed URLs, prompts and arbitrary errors', async () => {
  for (const scenario of ['success', 'dns', 'http', 'network', 'format', 'cancel', 'generation'] as const) {
    const events: Array<{ level: string; message: string; details: Record<string, unknown> }> = []
    const logger = Object.fromEntries(['debug', 'warn'].map(level => [level, (message: string, details: Record<string, unknown>) => events.push({ level, message, details })]))
    const controller = new AbortController()
    let calls = 0
    const secret = 'private-signature-do-not-log'
    const deps = dependencies((async () => {
      calls++
      if (calls === 1) return scenario === 'generation' ? json({}, 503) : json({ data: [{ url: `https://images.example.com/private-path?signature=${secret}` }] })
      if (scenario === 'network') throw new Error(`https://images.example.com/?signature=${secret}`, { cause: Object.assign(new Error(secret), { code: 'ECONNRESET' }) })
      if (scenario === 'cancel') { controller.abort(); controller.signal.throwIfAborted() }
      if (scenario === 'http') return new Response(secret, { status: 403 })
      return new Response(scenario === 'format' ? secret : png, { headers: { 'content-type': 'image/png', 'content-length': String(png.length) } })
    }) as typeof fetch)
    deps.logger = logger
    if (scenario === 'dns') deps.resolveDownloadAddresses = async () => ['198.18.0.1']
    if (scenario === 'success') await generateImage({ prompt: secret }, deps, controller.signal)
    else await assert.rejects(generateImage({ prompt: secret }, deps, controller.signal))
    const serialized = JSON.stringify(events)
    assert.ok(!serialized.includes(secret))
    assert.ok(!serialized.includes('private-path'))
    assert.ok(!serialized.includes('fixture-token'))
    assert.equal(new Set(events.map(event => event.details.requestId)).size, 1)
    const warnings = events.filter(event => event.level === 'warn')
    assert.equal(warnings.length, scenario === 'success' ? 0 : 1)
    if (scenario === 'success') {
      assert.ok(events.some(event => event.message.endsWith('Image validated') && event.details.mediaType === 'image/png'))
      assert.ok(events.some(event => event.message.endsWith('Download completed') && event.details.receivedBytes === png.length))
    } else {
      const failure = warnings[0].details
      assert.equal(failure.stage, scenario === 'dns' ? 'dns-validation' : scenario === 'format' ? 'image-validation' : scenario === 'generation' ? 'generation' : 'download')
      if (scenario === 'http') assert.equal(failure.status, 403)
      if (scenario === 'generation') assert.equal(failure.status, 503)
      if (scenario === 'network') assert.equal(failure.errorCode, 'ECONNRESET')
      if (scenario === 'cancel') assert.equal(failure.cancelled, true)
      if (scenario === 'dns') assert.equal(failure.reason, 'Unsafe image address')
    }
    assert.equal(calls, scenario === 'dns' || scenario === 'generation' ? 1 : 2)
  }
  assert.deepEqual(imageFailureDetails(Object.assign(new Error('secret'), { code: 'secret' })), { reason: 'Operation failed' })
})
function dependencies(fetch: ImageToolDependencies['fetch']): ImageToolDependencies { return { fetch, region: 'global', resolveCredentials: async () => creds, resolveDownloadAddresses: async () => ['93.184.216.34'], download: async (url, init) => fetch(url, init) } }
function decode(encoded: string): Record<string, unknown> {
  const alphabet = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!'
  const standard = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const a = Math.floor(encoded.length / 3)
  const reordered = encoded.slice(encoded.length - a) + encoded.slice(a, encoded.length - a) + encoded.slice(0, a)
  const b64 = Array.from(reordered, c => c === '$' ? '=' : standard[alphabet.indexOf(c)]).join('')
  return JSON.parse(Buffer.from(b64, 'base64').toString())
}
test('image protocol matches offline CLI WASM URL, body and signature fixtures', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/qoder-image-tools.json', import.meta.url), 'utf8'))
  for (const request of fixture.requests) {
    const kind = request.path.includes('imageSearch') ? 'imageSearch' : 'generateImage'
    assert.equal(imageToolUrl('global', kind), request.url)
    assert.equal(qoderEncodeBody(JSON.stringify({ payload: '{}', encodeVersion: '1' })), request.body)
    const auth = request.headers.Authorization.slice('Bearer COSY.'.length)
    const split = auth.lastIndexOf('.')
    const input = [auth.slice(0, split), request.headers['Cosy-Key'], request.headers['Cosy-Date'], request.body, computeSigPath(request.url)].join('\n')
    assert.equal(createHash('md5').update(input).digest('hex'), auth.slice(split + 1))
  }
  assert.equal(imageToolUrl('china', 'generateImage'), 'https://gateway.qoder.com.cn/algo/api/v2/service/pro/generateImage?Encode=1')
})
test('image search clips Unicode code points and retains structured aliases with default count', async () => {
  const deps = dependencies((async (_url, init) => {
    const body = decode(String(init?.body))
    const payload = JSON.parse(String(body.payload))
    assert.equal(payload.query, '😀'.repeat(100))
    assert.equal(payload.count, 5)
    assert.equal(typeof body.timestamp, 'string')
    assert.match(new Headers(init?.headers).get('authorization')!, /^Bearer COSY\./u)
    return json({ data: { images: [{ image_url: 'https://images.example.com/a.png', title: ' A ', imageWidth: '24' }] } })
  }) as typeof fetch)
  const result = await searchImages({ query: '😀'.repeat(101) }, deps)
  assert.equal(result.results[0].width, undefined)
  assert.equal(result.results[0].hostname, 'images.example.com')
  assert.equal(result.results[0].title, 'A')
})
test('static validation and pre-cancellation avoid credential resolution and network', async () => {
  let resolved = 0
  const transport = createQoderTransport({ region: 'global', resolvePat: async () => { resolved++; return 'unused' }, fetch: async () => { throw new Error('network must not run') } })
  await assert.rejects(transport.searchImages!({ query: 'x', count: 11 }))
  await assert.rejects(transport.generateImage!({ prompt: '' }))
  await assert.rejects(transport.searchImages!({ query: 'x' }, AbortSignal.abort()))
  assert.equal(resolved, 0)
})
test('generation uses ge3i, preserves host turn identity and downloads original bytes without auth', async () => {
  const hostRun = { id: 'host-run' }
  const modelRequest = await prepareQoderRequest({ provider: 'qoder', model: 'chat-model', sessionId: 'session' as never, messages: [] }, creds.userID, [], undefined, undefined, undefined, 'global', hostRun)
  let calls = 0
  const deps = dependencies((async (_url, init) => {
    calls++
    if (calls === 1) {
      const body = decode(String(init?.body)); const payload = JSON.parse(String(body.payload))
      assert.equal(payload.model, 'ge3i'); assert.equal(payload.size, '1024x1024')
      assert.equal(payload.metadata.business.id, modelRequest.business.id)
      assert.equal(payload.metadata.business.type, 'text2img')
      assert.equal(body.sessionId, modelRequest.sessionId)
      assert.equal(new Headers(init?.headers).get('X-RequestSet-ID'), modelRequest.requestSetId)
      return json({ data: [{ url: 'https://images.example.com/a.png?signature=private' }] })
    }
    assert.equal(init?.redirect, 'manual'); assert.equal(init?.credentials, 'omit')
    assert.equal(new Headers(init?.headers).get('authorization'), null)
    return new Response(png)
  }) as typeof fetch)
  const result = await generateImage({ prompt: 'cat', sessionId: 'session', hostRun }, deps)
  assert.equal(result.mediaType, 'image/png'); assert.deepEqual(Buffer.from(result.bytes), png)
})
test('uncertain generation failures never replay', async () => {
  for (const response of [new Response('oops', { status: 500 }), new Response('invalid JSON'), json({ code: 103 }), json({ data: [] })]) {
    let calls = 0
    const deps = dependencies((async () => { calls++; return response }) as typeof fetch)
    deps.refreshCredentials = async () => creds
    await assert.rejects(generateImage({ prompt: 'cat' }, deps)); assert.equal(calls, 1)
  }
})
test('image search 401 rejection refreshes once and reuses request identity and body', async () => {
  for (const status of [401]) {
    const bodies: unknown[] = []; let refreshed = 0
    const deps = dependencies((async (_url, init) => { bodies.push(init?.body); return bodies.length === 1 ? json({}, status) : json({ images: [] }) }) as typeof fetch)
    deps.refreshCredentials = async rejected => { assert.equal(rejected, creds); refreshed++; return { ...creds, authToken: 'renewed' } }
    const result = await searchImages({ query: 'cat' }, deps)
    assert.equal(refreshed, 1); assert.equal(bodies[0], bodies[1])
    assert.equal(result.requestId, decode(String(bodies[0])).requestId)
  }
})

test('image search hostname falls back independently and finite dimension aliases preserve zero and negatives', async () => {
  const result = await searchImages({ query: 'cat', count: 10 }, dependencies((async () => json({ images: [
    { imageUrl: 'https://images.example/a', sourceUrl: 'invalid source', width: '120', imageWidth: 42, height: null, imageHeight: -2 },
    { imageUrl: 'https://images.example/b', sourceUrl: 'https://source.example/page', width: 0, imageWidth: 99, height: -5, imageHeight: 99 },
    { imageUrl: 'https://images.example/c', sourceUrl: 'invalid source', hostname: ' Explicit ', width: false, imageWidth: 3, height: {}, imageHeight: 4 },
    { imageUrl: 'invalid image', sourceUrl: 'invalid source', width: '42', imageWidth: '43', height: '', imageHeight: '44' },
    { imageUrl: 'https://images.example/d', width: 1e400, imageWidth: 8, height: -1e400, imageHeight: 9 },
    { imageUrl: 'https://images.example/e', width: 1.5, imageWidth: 99, height: 2.5, imageHeight: 99 },
  ] })) as typeof fetch))
  assert.deepEqual(result.results.map(({ hostname, width, height }) => ({ hostname, width, height })), [
    { hostname: 'images.example', width: 42, height: -2 },
    { hostname: 'source.example', width: 0, height: -5 },
    { hostname: 'Explicit', width: 3, height: 4 },
    { hostname: undefined, width: undefined, height: undefined },
    { hostname: 'images.example', width: 8, height: 9 },
    { hostname: 'images.example', width: 1.5, height: 2.5 },
  ])
})

test('image search rxa classifies only number and string error codes and explicit success false', async () => {
  for (const code of [undefined, null, 0, '0', '', false, true, {}, []]) {
    const result = await searchImages({ query: 'cat' }, dependencies((async () => json({ code, images: [] })) as typeof fetch))
    assert.deepEqual(result.results, [])
  }
  for (const body of [{ code: 200 }, { code: -1 }, { code: '105' }, { code: ' ' }, { code: false, success: false }, { errorCode: 0, code: 200, success: false }]) {
    await assert.rejects(searchImages({ query: 'cat' }, dependencies((async () => json(body)) as typeof fetch)), (error: unknown) => {
      assert.ok(error instanceof QoderImageSearchError)
      assert.equal(error.reason, 'backend')
      return true
    })
  }
  assert.deepEqual((await searchImages({ query: 'cat' }, dependencies((async () => json({ errorCode: 0, code: 200, images: [] })) as typeof fetch))).results, [])
})

test('image search safe errors retain reason, request identity, HTTP status and numeric business code', async () => {
  for (const [response, reason, httpStatus, upstreamCode] of [
    [json({ message: 'secret' }, 401), 'auth', 401, undefined],
    [json({ message: 'secret' }, 403), 'auth', 403, undefined],
    [json({ message: 'secret' }, 503), 'http', 503, undefined],
    [new Response('invalid JSON secret'), 'parse', undefined, undefined],
    [json({ code: 105, message: 'secret' }), 'backend', undefined, '105'],
    [json({ code: 'https://private?token=secret', error: 'secret' }), 'backend', undefined, undefined],
  ] as const) {
    let requestId: unknown
    let calls = 0
    const deps = dependencies((async (_url, init) => { calls++; requestId = decode(String(init?.body)).requestId; return response }) as typeof fetch)
    await assert.rejects(searchImages({ query: 'cat' }, deps), (error: unknown) => {
      assert.ok(error instanceof QoderImageSearchError)
      assert.equal(error.reason, reason)
      assert.equal(error.requestId, requestId)
      assert.equal(error.httpStatus, httpStatus)
      assert.equal(error.upstreamCode, upstreamCode)
      assert.ok(error.message.includes(reason))
      assert.ok(error.message.includes(String(requestId)))
      if (httpStatus) assert.ok(error.message.includes(String(httpStatus)))
      if (upstreamCode) assert.ok(error.message.includes(`code ${upstreamCode}`))
      assert.doesNotMatch(error.message + JSON.stringify(error), /secret|https:/u)
      return true
    })
    assert.equal(calls, 1)
  }
})

test('image search preserves terminal authentication classification after one refresh', async () => {
  for (const status of [401, 403]) {
    let calls = 0; let refreshes = 0
    const deps = dependencies((async () => { calls++; return json({ message: 'secret' }, status) }) as typeof fetch)
    deps.refreshCredentials = async () => { refreshes++; return creds }
    await assert.rejects(searchImages({ query: 'cat' }, deps), (error: unknown) => {
      assert.ok(error instanceof QoderImageSearchError)
      assert.equal(error.reason, 'auth')
      assert.equal(error.httpStatus, status)
      return true
    })
    assert.equal(calls, status === 401 ? 2 : 1); assert.equal(refreshes, status === 401 ? 1 : 0)
  }
})

test('image search classifies credential and network errors without echoing arbitrary messages', async () => {
  for (const [failure, reason] of [
    [Object.assign(new Error('secret'), { code: 'auth_required' }), 'auth'],
    [new QoderLlmError('secret', 'MISSING_CREDENTIAL'), 'auth'],
    [Object.assign(new Error('secret'), { statusCode: 403 }), 'auth'],
    [Object.assign(new Error('secret'), { httpStatus: 401 }), 'auth'],
    [new Error('https://private?token=secret'), 'http'],
  ] as const) {
    for (const stage of ['credentials', 'network', 'refresh']) {
      const deps = dependencies((async () => { if (stage === 'network') throw failure; return json({}, 401) }) as typeof fetch)
      if (stage === 'credentials') deps.resolveCredentials = async () => { throw failure }
      if (stage === 'refresh') deps.refreshCredentials = async () => { throw failure }
      await assert.rejects(searchImages({ query: 'cat' }, deps), (error: unknown) => {
        assert.ok(error instanceof QoderImageSearchError)
        assert.equal(error.reason, reason)
        assert.ok(error.requestId)
        assert.doesNotMatch(error.message + JSON.stringify(error), /secret|https:/u)
        return true
      })
    }
  }
  let fetched = false
  const transport = createQoderTransport({ region: 'global', resolvePat: async () => '', fetch: async () => { fetched = true; throw new Error('must not fetch') } })
  await assert.rejects(transport.searchImages!({ query: 'cat' }), (error: unknown) => {
    assert.ok(error instanceof QoderImageSearchError)
    assert.equal(error.reason, 'auth')
    assert.ok(error.requestId)
    return true
  })
  assert.equal(fetched, false)
})

test('image search cancellation remains cancellation in credentials, network, parsing and completed JSON', async () => {
  for (const stage of ['credentials', 'network', 'parsing', 'completed']) {
    const controller = new AbortController()
    const cancelled = new DOMException('cancelled', 'AbortError')
    const deps = dependencies((async () => {
      if (stage === 'network') { controller.abort(cancelled); throw new Error('network interrupted') }
      if (stage === 'parsing') return new Response(new ReadableStream({ start(stream) { controller.abort(cancelled); stream.error(new Error('body interrupted')) } }))
      controller.abort(cancelled)
      return json({ code: 105 })
    }) as typeof fetch)
    if (stage === 'credentials') deps.resolveCredentials = async () => { controller.abort(cancelled); throw new Error('credentials interrupted') }
    await assert.rejects(searchImages({ query: 'cat' }, deps, controller.signal), error => error === cancelled)
  }
  for (const cancelled of [new DOMException('cancelled', 'AbortError'), new QoderLlmError('cancelled', 'ABORTED')]) {
    const deps = dependencies((async () => { throw cancelled }) as typeof fetch)
    await assert.rejects(searchImages({ query: 'cat' }, deps), error => error === cancelled)
  }
})
test('generated delivery failures retain safe recovery identity and never replay generation', async () => {
  for (const url of ['ftp://images.example.com/a.png', 'https://127.0.0.1/a.png', 'https://localhost/a.png', 'https://user:pass@images.example.com/a.png']) {
    let calls = 0
    const deps = dependencies((async () => { calls++; return json({ data: [{ url }] }) }) as typeof fetch)
    await assert.rejects(generateImage({ prompt: 'cat' }, deps), (error: unknown) => {
      assert.ok(error instanceof QoderImageDeliveryError)
      assert.equal(error.imageUrl, url); assert.ok(error.requestId)
      assert.ok(!JSON.stringify(error).includes(url)); return true
    })
    assert.equal(calls, 1)
  }
})
test('downloads reject non-raster bodies and content-length exceeding byte budget', async () => {
  for (const response of [new Response('<svg/>'), new Response('x', { headers: { 'content-length': String(32 * 1024 * 1024 + 1) } })]) {
    let calls = 0
    const deps = dependencies((async () => ++calls === 1 ? json({ data: [{ url: 'https://images.example.com/a' }] }) : response) as typeof fetch)
    await assert.rejects(generateImage({ prompt: 'cat' }, deps), QoderImageDeliveryError)
    assert.equal(calls, 2)
  }
})

test('image delivery rejects every private or reserved DNS answer, including mixed answers', async () => {
  for (const addresses of [['127.0.0.1'], ['10.0.0.1'], ['169.254.169.254'], ['::1'], ['::ffff:127.0.0.1'], ['fc00::1'], ['2001:db8::1'], ['93.184.216.34', '192.168.1.1'], []]) {
    let calls = 0
    const deps = dependencies((async () => { calls++; return json({ data: [{ url: 'https://private.example.com/a' }] }) }) as typeof fetch)
    deps.resolveDownloadAddresses = async () => addresses
    await assert.rejects(generateImage({ prompt: 'cat' }, deps), QoderImageDeliveryError)
    assert.equal(calls, 1)
  }
})

test('CLI image search rejects nonzero code while generation accepts data regardless of code', async () => {
  await assert.rejects(searchImages({ query: 'cat' }, dependencies((async () => json({ code: 200, images: [] })) as typeof fetch)))
  let calls = 0
  const deps = dependencies((async () => ++calls === 1 ? json({ code: 200, data: [{ url: 'https://images.example.com/a.png' }] }) : new Response(png)) as typeof fetch)
  assert.equal((await generateImage({ prompt: 'cat' }, deps)).mediaType, 'image/png')
})

test('native image download pins public DNS without changing TLS hostname or carrying subscriber auth', async () => {
  const fake = ((url: string, options: RequestOptions, callback: (response: IncomingMessage) => void) => {
    assert.equal(url, 'https://images.example.com/a.png')
    assert.equal(options.rejectUnauthorized, undefined)
    assert.equal(options.agent, false)
    assert.deepEqual(options.headers, { Accept: 'image/*', 'Accept-Encoding': 'identity' })
    const lookup = options.lookup!
    lookup('images.example.com', { all: true }, ((error: unknown, addresses: unknown) => {
      assert.equal(error, null)
      assert.deepEqual(addresses, [{ address: '93.184.216.34', family: 4 }])
    }) as never)
    const request = new EventEmitter() as EventEmitter & { end: () => void }
    request.end = () => callback(Object.assign(Readable.from([png]), { headers: {}, statusCode: 200 }) as IncomingMessage)
    return request
  }) as unknown as typeof httpsRequest
  const result = await pinnedDownload('https://images.example.com/a.png', {}, ['93.184.216.34'], fake)
  assert.deepEqual(Buffer.from(await result.arrayBuffer()), png)
})

test('download enforces streamed byte budget even without content-length and cancels the body', async () => {
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(32 * 1024 * 1024 + 1)) },
    cancel() { cancelled = true },
  })
  let calls = 0
  const deps = dependencies((async () => ++calls === 1 ? json({ data: [{ url: 'https://images.example.com/a' }] }) : new Response(body)) as typeof fetch)
  await assert.rejects(generateImage({ prompt: 'cat' }, deps), QoderImageDeliveryError)
  assert.equal(cancelled, true)
  assert.equal(calls, 2)
})

test('inline image data URLs decode original bytes without DNS/download and redact all image content', async () => {
  for (const encoded of [png.toString('base64'), png.toString('base64').replace(/=+$/u, ''), png.toString('base64').replace(/.{12}/gu, '$& \n')]) {
    let submissions = 0
    const logs: unknown[] = []
    const deps = dependencies((async () => { submissions++; return json({ data: [{ url: `data:image/png;base64,${encoded}` }] }) }) as typeof fetch)
    deps.resolveDownloadAddresses = async () => { throw new Error('Inline images must not resolve DNS') }
    deps.download = async () => { throw new Error('Inline images must not download') }
    deps.logger = { debug: (message, details) => logs.push({ message, details }), warn: (message, details) => logs.push({ message, details }) }
    const result = await generateImage({ prompt: 'cat' }, deps)
    assert.deepEqual(Buffer.from(result.bytes), png)
    assert.equal(result.mediaType, 'image/png')
    assert.equal(submissions, 1)
    const diagnostic = inspectImageUrl(result.imageUrl)
    assert.deepEqual(diagnostic, { protocol: 'data:', encoding: 'base64', rejection: undefined })
    assert.ok(JSON.stringify(logs).includes('Data URL decoded'))
    assert.ok(!JSON.stringify(logs).includes(png.toString('base64').slice(0, 12)))
  }
})

test('inline image failures reject malformed base64, unsupported content, empty and non-raster bytes without replay', async () => {
  for (const [url, reason] of [
    ['data:image/png,not-base64', 'Invalid image data URL'],
    ['data:image/png;base64,%%%%', 'Invalid image base64 data'],
    ['data:image/png;base64,A', 'Invalid image base64 data'],
    ['data:image/png;base64,AA=A', 'Invalid image base64 data'],
    [`data:text/html;base64,${png.toString('base64')}`, 'Unsupported image content type'],
    ['data:image/png;base64,', 'Generated image is empty'],
    ['data:image/png;base64,PHN2Zy8+', 'Generated result is not a supported raster image'],
  ]) {
    let submissions = 0
    const warnings: unknown[] = []
    const deps = dependencies((async () => { submissions++; return json({ data: [{ url }] }) }) as typeof fetch)
    deps.logger = { warn: (_message, details) => warnings.push(details) }
    await assert.rejects(generateImage({ prompt: 'cat' }, deps), (error: unknown) => {
      assert.ok(error instanceof QoderImageDeliveryError)
      assert.equal(imageFailureDetails(error.cause).reason, reason)
      assert.ok(!JSON.stringify(error).includes(url))
      return true
    })
    assert.equal(submissions, 1)
    assert.equal(warnings.length, 1)
    assert.ok(!JSON.stringify(warnings).includes(url))
  }
})

test('inline images allow the full 32 MiB decoded budget beyond the metadata JSON limit', async () => {
  const bytes = Buffer.alloc(32 * 1024 * 1024)
  png.copy(bytes)
  let submissions = 0
  const deps = dependencies((async () => {
    submissions++
    return json({ data: [{ url: `data:image/png;base64,${bytes.toString('base64')}` }] })
  }) as typeof fetch)
  const result = await generateImage({ prompt: 'cat' }, deps)
  assert.equal(result.bytes.length, bytes.length)
  assert.deepEqual(Buffer.from(result.bytes), bytes)
  assert.equal(submissions, 1)
})

test('inline decoded size and encoded envelope are bounded before allocating image bytes', async () => {
  // 32 MiB + 1 bytes fits the URL envelope but exceeds the decoded-byte budget.
  const bytes = Buffer.alloc(32 * 1024 * 1024 + 1)
  png.copy(bytes)
  for (const suffix of ['', ' '.repeat(1024)]) {
    let submissions = 0
    const deps = dependencies((async () => { submissions++; return json({ data: [{ url: `data:image/png;base64,${bytes.toString('base64')}${suffix}` }] }) }) as typeof fetch)
    await assert.rejects(generateImage({ prompt: 'cat' }, deps), (error: unknown) => {
      assert.ok(error instanceof QoderImageDeliveryError)
      assert.equal(imageFailureDetails(error.cause).reason, 'Generated image exceeds 32 MiB limit')
      return true
    })
    assert.equal(submissions, 1)
  }
})

test('AVIF still/sequence brands and CLI raster signatures determine media type independently of MIME labels', async () => {
  const samples: Array<[Buffer, string]> = [
    [png.subarray(0, 8), 'image/png'],
    [Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg'],
    [Buffer.from('RIFF0000WEBP'), 'image/webp'],
    [Buffer.from('GIF87a'), 'image/gif'],
    [Buffer.from('GIF89a'), 'image/gif'],
    [Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypavif')]), 'image/avif'],
    [Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypavis')]), 'image/avif'],
  ]
  for (const [bytes, mediaType] of samples) {
    for (const inline of [true, false]) {
      let calls = 0
      const deps = dependencies((async () => ++calls === 1
        ? json({ data: [{ url: inline ? `data:image/png;base64,${bytes.toString('base64')}` : 'https://images.example.com/a' }] })
        : new Response(new Uint8Array(bytes), { headers: { 'content-type': 'binary/octet-stream' } })) as typeof fetch)
      const result = await generateImage({ prompt: 'cat' }, deps)
      assert.equal(result.mediaType, mediaType)
      assert.deepEqual(Buffer.from(result.bytes), bytes)
    }
  }
})

test('HTTP/HTTPS downloads accept public IPs and custom ports while retaining private-address checks', async () => {
  for (const url of ['http://images.example.com:8080/a', 'https://images.example.com:8443/a', 'http://93.184.216.34:8080/a', 'https://[2606:4700:4700::1111]/a']) {
    const resolved: string[] = []
    const deps = dependencies((async () => json({ data: [{ url }] })) as typeof fetch)
    deps.resolveDownloadAddresses = async hostname => { resolved.push(hostname); return ['93.184.216.34'] }
    deps.download = async (target, init, addresses) => {
      assert.equal(target, url)
      assert.equal(init.credentials, 'omit')
      assert.equal(new Headers(init.headers).get('authorization'), null)
      assert.deepEqual(addresses, [url.includes('[2606') ? '2606:4700:4700::1111' : '93.184.216.34'])
      return new Response(png)
    }
    assert.equal(inspectImageUrl(url).rejection, undefined)
    assert.equal((await generateImage({ prompt: 'cat' }, deps)).mediaType, 'image/png')
    assert.deepEqual(resolved, url.includes('images.example.com') ? ['images.example.com'] : [])
  }
})

test('all CLI redirect statuses resolve relative locations and revalidate/pin every hop without credentials', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const dns: string[] = []
    let submissions = 0
    let downloads = 0
    let cancelled = false
    const logs: unknown[] = []
    const deps = dependencies((async () => { submissions++; return json({ data: [{ url: 'https://images.example.com/path/a?signature=secret-initial' }] }) }) as typeof fetch)
    deps.logger = { debug: (message, details) => logs.push({ message, details }), warn: (message, details) => logs.push({ message, details }) }
    deps.resolveDownloadAddresses = async hostname => { dns.push(hostname); return [dns.length === 1 ? '93.184.216.34' : '1.1.1.1'] }
    deps.download = async (url, init, addresses) => {
      downloads++
      assert.equal(init.redirect, 'manual')
      assert.equal(init.credentials, 'omit')
      assert.equal(new Headers(init.headers).get('authorization'), null)
      assert.deepEqual(addresses, [downloads === 1 ? '93.184.216.34' : '1.1.1.1'])
      if (downloads === 1) return new Response(new ReadableStream({ cancel() { cancelled = true } }), { status, headers: { location: '../result?signature=secret-redirect' } })
      assert.equal(url, 'https://images.example.com/result?signature=secret-redirect')
      return new Response(png)
    }
    assert.deepEqual(Buffer.from((await generateImage({ prompt: 'cat' }, deps)).bytes), png)
    assert.deepEqual(dns, ['images.example.com', 'images.example.com'])
    assert.equal(submissions, 1)
    assert.equal(downloads, 2)
    assert.equal(cancelled, true)
    assert.ok(!JSON.stringify(logs).includes('secret-'))
    assert.ok(!JSON.stringify(logs).includes('/result'))
  }
})

test('redirects cannot reach unsafe protocols, credentials, local IPs or mixed/private DNS answers', async () => {
  for (const [location, addresses] of [
    ['file:///etc/passwd', ['93.184.216.34']],
    [`data:image/png;base64,${png.toString('base64')}`, ['93.184.216.34']],
    ['http://user:password@images.example.com/a', ['93.184.216.34']],
    ['http://127.0.0.1/a', ['93.184.216.34']],
    ['http://[::1]/a', ['93.184.216.34']],
    ['http://host.internal/a', ['93.184.216.34']],
    ['http://next.example.com/a', ['10.0.0.1']],
    ['https://images.example.com/a', ['93.184.216.34', '169.254.169.254']],
  ] as Array<[string, string[]]>) {
    let submissions = 0
    let downloads = 0
    let lookups = 0
    const deps = dependencies((async () => { submissions++; return json({ data: [{ url: 'https://images.example.com/a' }] }) }) as typeof fetch)
    deps.resolveDownloadAddresses = async () => ++lookups === 1 ? ['93.184.216.34'] : addresses
    deps.download = async () => { downloads++; return new Response(null, { status: 302, headers: { location } }) }
    await assert.rejects(generateImage({ prompt: 'cat' }, deps), QoderImageDeliveryError)
    assert.equal(submissions, 1)
    assert.equal(downloads, 1)
  }
})

test('exactly five redirects succeed; the sixth is rejected and missing Location is clear', async () => {
  for (const count of [5, 6]) {
    let submissions = 0
    let downloads = 0
    const deps = dependencies((async () => { submissions++; return json({ data: [{ url: 'https://images.example.com/start' }] }) }) as typeof fetch)
    deps.download = async () => ++downloads <= count ? new Response(null, { status: 302, headers: { location: `/hop-${downloads}` } }) : new Response(png)
    if (count === 5) assert.equal((await generateImage({ prompt: 'cat' }, deps)).mediaType, 'image/png')
    else await assert.rejects(generateImage({ prompt: 'cat' }, deps), (error: unknown) => {
      assert.ok(error instanceof QoderImageDeliveryError)
      assert.equal(imageFailureDetails(error.cause).reason, 'Generated image exceeded 5 redirects')
      return true
    })
    assert.equal(submissions, 1)
    assert.equal(downloads, 6)
  }
  const deps = dependencies((async () => json({ data: [{ url: 'https://images.example.com/start' }] })) as typeof fetch)
  deps.download = async () => new Response(null, { status: 302 })
  await assert.rejects(generateImage({ prompt: 'cat' }, deps), (error: unknown) => {
    assert.ok(error instanceof QoderImageDeliveryError)
    assert.equal(imageFailureDetails(error.cause).reason, 'Image redirect is missing Location')
    return true
  })
})

test('HTTP image content-type rejection happens before reading even magic-byte-compatible bodies', async () => {
  let cancelled = false
  const deps = dependencies((async () => json({ data: [{ url: 'https://images.example.com/a' }] })) as typeof fetch)
  deps.download = async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(png) }, cancel() { cancelled = true } }), { headers: { 'content-type': 'text/html' } })
  await assert.rejects(generateImage({ prompt: 'cat' }, deps), (error: unknown) => {
    assert.ok(error instanceof QoderImageDeliveryError)
    assert.equal(imageFailureDetails(error.cause).reason, 'Unsupported image content type')
    return true
  })
  assert.equal(cancelled, true)
})

test('download deadlines interrupt DNS, headers and stalled bodies without replaying generation', async () => {
  // Keep the process alive while AbortSignal.timeout's unref'ed timer is active.
  const keepAlive = setInterval(() => {}, 1000)
  try {
    for (const stage of ['dns-validation', 'download-headers', 'download-body']) {
      let submissions = 0
      let cancelled = false
      const warnings: Array<Record<string, unknown>> = []
      const deps = dependencies((async () => { submissions++; return json({ data: [{ url: 'https://images.example.com/a' }] }) }) as typeof fetch)
      deps.downloadTimeoutMs = 15
      deps.logger = { warn: (_message, details) => warnings.push(details as Record<string, unknown>) }
      if (stage === 'dns-validation') deps.resolveDownloadAddresses = () => new Promise(() => {})
      deps.download = stage === 'download-headers' ? () => new Promise(() => {}) : async () => new Response(new ReadableStream({ cancel() { cancelled = true } }))
      await assert.rejects(generateImage({ prompt: 'cat' }, deps), QoderImageDeliveryError)
      assert.equal(submissions, 1)
      assert.equal(warnings.length, 1)
      assert.equal(warnings[0].timedOut, true)
      assert.equal(warnings[0].reason, 'Image delivery timed out')
      assert.equal(warnings[0].stage, stage === 'dns-validation' ? stage : 'download')
      if (stage === 'download-body') assert.equal(cancelled, true)
    }
  } finally { clearInterval(keepAlive) }
})

test('native image downloads select HTTP or HTTPS and use only the validated DNS address', async () => {
  const calls: string[] = []
  const fakeRequest = (protocol: string) => ((url: string, options: RequestOptions, callback: (response: IncomingMessage) => void) => {
    calls.push(protocol)
    assert.equal(new URL(url).protocol, protocol)
    assert.equal(options.agent, false)
    assert.equal(options.rejectUnauthorized, undefined)
    assert.equal(options.signal?.aborted, false)
    assert.deepEqual(options.headers, { Accept: 'image/*', 'Accept-Encoding': 'identity' })
    options.lookup!('images.example.com', { all: true }, ((error: unknown, addresses: unknown) => {
      assert.equal(error, null)
      assert.deepEqual(addresses, [{ address: '93.184.216.34', family: 4 }])
    }) as never)
    const request = new EventEmitter() as EventEmitter & { end: () => void }
    request.end = () => callback(Object.assign(Readable.from([png]), { headers: { 'content-type': 'image/png' }, statusCode: 200 }) as IncomingMessage)
    return request
  }) as unknown as typeof httpsRequest
  // Mock the native modules and synchronize their named exports: no sockets open.
  const httpMock = mock.method(http, 'request', fakeRequest('http:'))
  const httpsMock = mock.method(https, 'request', fakeRequest('https:'))
  syncBuiltinESMExports()
  try {
    for (const url of ['http://images.example.com:8080/a', 'https://images.example.com:8443/a']) {
      const deps = dependencies((async () => json({ data: [{ url }] })) as typeof fetch)
      delete deps.download
      assert.deepEqual(Buffer.from((await generateImage({ prompt: 'cat' }, deps)).bytes), png)
    }
    assert.deepEqual(calls, ['http:', 'https:'])
  } finally {
    httpMock.mock.restore()
    httpsMock.mock.restore()
    syncBuiltinESMExports()
  }
})

test('download allows exactly 32 MiB and cancellation after a redirect does not report stale HTTP status', async () => {
  const bytes = new Uint8Array(32 * 1024 * 1024)
  bytes.set(png)
  const deps = dependencies((async () => json({ data: [{ url: 'https://images.example.com/a' }] })) as typeof fetch)
  deps.download = async () => new Response(bytes, { headers: { 'content-length': String(bytes.length) } })
  assert.equal((await generateImage({ prompt: 'cat' }, deps)).bytes.length, bytes.length)
  let downloads = 0
  let dns = 0
  const warnings: Array<Record<string, unknown>> = []
  const controller = new AbortController()
  deps.logger = { warn: (_message, details) => warnings.push(details as Record<string, unknown>) }
  deps.resolveDownloadAddresses = async () => {
    if (++dns === 2) controller.abort()
    return ['93.184.216.34']
  }
  deps.download = async () => { downloads++; return new Response(null, { status: 302, headers: { location: '/next' } }) }
  await assert.rejects(generateImage({ prompt: 'cat' }, deps, controller.signal), QoderImageDeliveryError)
  assert.equal(downloads, 1)
  assert.equal(warnings.length, 1)
  assert.equal(warnings[0].status, undefined)
  assert.equal(warnings[0].cancelled, true)
  assert.equal(warnings[0].reason, 'Image delivery cancelled')
})
