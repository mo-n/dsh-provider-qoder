import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import type { IncomingMessage } from 'node:http'
import type { RequestOptions, request as httpsRequest } from 'node:https'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { searchImages, generateImage, imageToolUrl, pinnedDownload, type ImageToolDependencies } from '../src/qoder/transport/image-tools.ts'
import { QoderImageDeliveryError } from '../src/qoder/images.ts'
import { qoderEncodeBody } from '../src/qoder/transport/wire/encoding.ts'
import { computeSigPath } from '../src/qoder/transport/wire/cosy.ts'
import { prepareQoderRequest } from '../src/qoder/transport/wire/prepare.ts'
import { createQoderTransport } from '../src/qoder/transport/index.ts'
const creds = { userID: 'fixture-user', authToken: 'fixture-token', name: 'Fixture', email: '', machineID: 'fixture-machine' }
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
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
  assert.equal(result.results[0].width, 24)
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
    assert.equal(init?.redirect, 'error'); assert.equal(init?.credentials, 'omit')
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
test('explicit 401 rejection refreshes once and reuses the encoded request', async () => {
  const bodies: unknown[] = []; let refreshed = 0
  const deps = dependencies((async (_url, init) => { bodies.push(init?.body); return bodies.length === 1 ? json({}, 401) : json({ images: [] }) }) as typeof fetch)
  deps.refreshCredentials = async () => { refreshed++; return { ...creds, authToken: 'renewed' } }
  await searchImages({ query: 'cat' }, deps)
  assert.equal(refreshed, 1); assert.equal(bodies[0], bodies[1])
})
test('generated delivery failures retain safe recovery identity and never replay generation', async () => {
  for (const url of ['http://images.example.com/a.png', 'https://127.0.0.1/a.png', 'https://localhost/a.png', 'https://user:pass@images.example.com/a.png']) {
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
  for (const response of [new Response('<svg/>'), new Response('x', { headers: { 'content-length': String(26 * 1024 * 1024) } })]) {
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
    start(controller) { controller.enqueue(new Uint8Array(25 * 1024 * 1024 + 1)) },
    cancel() { cancelled = true },
  })
  let calls = 0
  const deps = dependencies((async () => ++calls === 1 ? json({ data: [{ url: 'https://images.example.com/a' }] }) : new Response(body)) as typeof fetch)
  await assert.rejects(generateImage({ prompt: 'cat' }, deps), QoderImageDeliveryError)
  assert.equal(cancelled, true)
  assert.equal(calls, 2)
})
