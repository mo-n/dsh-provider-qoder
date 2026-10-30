/** Image protocols verified offline against qodercli 1.1.73 WASM prepareRequest. */
import { randomUUID } from 'node:crypto'
import { BlockList, isIP } from 'node:net'
import { lookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { Readable } from 'node:stream'
import { QoderLlmError } from '../errors.ts'
import { imageFailureDetails, QoderImageDeliveryError, QoderImageSearchError, type QoderImageGenerationRequest, type QoderImageGenerationResult, type QoderImageSearchRequest, type QoderImageSearchResult, type QoderImageSearchItem } from '../images.ts'
import type { QoderLogger } from './logging.ts'
import { imageResponseDiagnostic, inspectImageUrl } from './image-diagnostics.ts'
import { resolveQoderEndpoints, type QoderRegion } from './endpoints.ts'
import { buildAuthHeaders, type CosyCredentials } from './wire/cosy.ts'
import { qoderEncodeBody } from './wire/encoding.ts'
import { qoderTurnTracker, qoderSessionId } from './wire/prepare.ts'
import { qoderIdeVersion } from './wire/client-identity.ts'
import { defaultMaxJsonBytes, readLimitedText } from './request.ts'

type Obj = Record<string, unknown>
const record = (value: unknown): Obj | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Obj : undefined
// qodercli 1.1.73 YKe/gTu/fTu: decoded bytes, redirects and per-download deadline.
const maxImageBytes = 32 * 1024 * 1024
const maxDataUrlCharacters = 4 * Math.ceil(maxImageBytes / 3) + 1024
const maxGenerationJsonBytes = maxDataUrlCharacters + defaultMaxJsonBytes
const maxImageRedirects = 5
const imageDownloadTimeoutMs = 600_000
function string(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value.trim() : undefined }
function pick(value: Obj, keys: string[]): string | undefined {
  for (const key of keys) { const found = string(value[key]); if (found) return found }
}
export function validateImageSearch(request: QoderImageSearchRequest): void {
  if (!string(request.query) || (request.count !== undefined && (!Number.isInteger(request.count) || request.count < 1 || request.count > 10))) throw new QoderLlmError('ImageSearch requires query and an integer count from 1 to 10.', 'INVALID_REQUEST')
}
export function validateImageGeneration(request: QoderImageGenerationRequest): void {
  if (!string(request.prompt) || (request.size !== undefined && !/^\d{2,5}x\d{2,5}$/u.test(request.size))) throw new QoderLlmError('ImageGen requires prompt and a size such as 1024x1024.', 'INVALID_REQUEST')
}
export interface ImageToolDependencies {
  logger?: QoderLogger
  fetch: typeof fetch
  region: QoderRegion
  resolveCredentials: (signal?: AbortSignal) => Promise<CosyCredentials>
  refreshCredentials?: (rejected: CosyCredentials, signal?: AbortSignal) => Promise<CosyCredentials>
  timeoutMs?: number
  /** Offline test seam; production uses the CLI's ten-minute deadline per hop. */
  downloadTimeoutMs?: number
  /** Test seam: production uses OS DNS resolution before downloading. */
  resolveDownloadAddresses?: (hostname: string) => Promise<readonly string[]>
  /** Inject only in offline tests; default download pins a verified public DNS answer. */
  download?: (url: string, init: RequestInit, addresses: readonly string[]) => Promise<Response>
}
export function imageToolUrl(region: QoderRegion, kind: 'imageSearch' | 'generateImage'): string {
  // WASM normalizes an existing /algo prefix instead of prepending it twice.
  return `${resolveQoderEndpoints(region).baseUrl}algo/api/v2/service/pro/${kind}?Encode=1`
}
async function post(kind: 'imageSearch' | 'generateImage', outer: Obj, deps: ImageToolDependencies, signal?: AbortSignal, requestSetId?: string): Promise<unknown> {
  const timeout = AbortSignal.timeout(deps.timeoutMs ?? (kind === 'generateImage' ? 180_000 : 30_000))
  const activeSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
  activeSignal.throwIfAborted()
  const body = qoderEncodeBody(JSON.stringify(outer))
  const url = imageToolUrl(deps.region, kind)
  let credentials = await deps.resolveCredentials(activeSignal)
  for (let attempt = 0; attempt < 2; attempt++) {
    activeSignal.throwIfAborted()
    const response = await deps.fetch(url, { method: 'POST', body, redirect: 'error', signal: activeSignal,
      headers: { ...buildAuthHeaders(body, url, credentials), 'Content-Type': 'application/json', Accept: 'application/json', 'Accept-Encoding': 'identity',
        ...requestSetId ? { 'X-RequestSet-ID': requestSetId } : {} } })
    if (kind === 'generateImage') deps.logger?.debug?.('[Qoder Image] Generation response headers', { requestId: outer.requestId, status: response.status, attempt: attempt + 1 })
    // Only explicit HTTP authentication rejection may replay, never an uncertain failure.
    if (response.status === 401 && attempt === 0 && deps.refreshCredentials) {
      await response.body?.cancel()
      credentials = await deps.refreshCredentials(credentials, activeSignal)
      continue
    }
    if (!response.ok) {
      await response.body?.cancel()
      if (kind === 'imageSearch') throw new QoderImageSearchError(response.status === 401 || response.status === 403 ? 'auth' : 'http', String(outer.requestId), { httpStatus: response.status })
      const error = new QoderLlmError(`Qoder ${kind} failed (HTTP ${response.status}); request ${String(outer.requestId)}.`, 'PROVIDER_ERROR')
      error.httpStatus = response.status
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(await readLimitedText(response, kind === 'generateImage' ? maxGenerationJsonBytes : defaultMaxJsonBytes, `Qoder ${kind} response`))
    } catch (error) {
      signal?.throwIfAborted()
      if (kind === 'imageSearch') {
        if (isImageSearchCancellation(error)) throw error
        throw new QoderImageSearchError('parse', String(outer.requestId))
      }
      throw error
    }
    if (kind === 'imageSearch') activeSignal.throwIfAborted()
    if (kind === 'generateImage') deps.logger?.debug?.('[Qoder Image] Generation response body', {
      requestId: outer.requestId, status: response.status, response: imageResponseDiagnostic(parsed),
    })
    const obj = record(parsed)
    // CLI image-search rxa treats any nonzero errorCode/code (including 200) as failure.
    // Image generation instead consumes data[0].url without interpreting a status code.
    const code = kind === 'imageSearch' ? obj?.errorCode ?? obj?.code : undefined
    if (typeof code === 'number' && code !== 0 || typeof code === 'string' && code !== '' && code !== '0' || kind === 'imageSearch' && obj?.success === false) {
      throw new QoderImageSearchError('backend', String(outer.requestId), { upstreamCode: typeof code === 'number' || typeof code === 'string' ? String(code) : undefined })
    }
    return parsed
  }
}
function items(value: unknown, depth = 0): unknown[] {
  if (Array.isArray(value)) return value
  const obj = record(value)
  if (!obj || depth > 4) return []
  for (const key of ['results', 'data', 'items', 'imageItems', 'images', 'pageItems']) if (Array.isArray(obj[key])) return obj[key] as unknown[]
  for (const key of ['data', 'result', 'payload']) { const found = items(obj[key], depth + 1); if (found.length) return found }
  return []
}
function parseItem(value: unknown): QoderImageSearchItem | undefined {
  const obj = record(value) ?? (typeof value === 'string' ? { imageUrl: value } : undefined)
  if (!obj) return
  const imageUrl = pick(obj, ['imageUrl', 'image_url', 'image', 'url', 'originalUrl', 'originUrl', 'ossUrl', 'link'])
  const thumbnailUrl = pick(obj, ['thumbnailUrl', 'thumbnail_url', 'thumbUrl', 'thumb_url', 'thumbnail', 'previewUrl', 'preview_url']) ?? imageUrl
  const sourceUrl = pick(obj, ['sourceUrl', 'source_url', 'pageUrl', 'page_url', 'webpageUrl', 'webpage_url', 'contextUrl', 'context_url', 'hostPageUrl', 'host_page_url']) ?? imageUrl
  const title = pick(obj, ['title', 'name', 'alt', 'description', 'snippet'])
  const hostname = pick(obj, ['hostname', 'host', 'source', 'siteName']) ?? imageHostname(sourceUrl) ?? imageHostname(imageUrl)
  if (!imageUrl && !thumbnailUrl && !sourceUrl && !title) return
  const result: QoderImageSearchItem = { ...title ? { title } : {}, ...imageUrl ? { imageUrl } : {}, ...thumbnailUrl ? { thumbnailUrl } : {}, ...sourceUrl ? { sourceUrl } : {}, ...hostname ? { hostname } : {} }
  for (const key of ['width', 'height'] as const) {
    for (const field of [key, key === 'width' ? 'imageWidth' : 'imageHeight']) {
      const n = obj[field]
      if (typeof n === 'number' && Number.isFinite(n)) { result[key] = n; break }
    }
  }
  return result
}
function imageHostname(value: string | undefined): string | undefined {
  if (value) try { return new URL(value).hostname } catch { /* Optional hostname. */ }
}
function isImageSearchCancellation(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || 'code' in error && (error.code === 'ABORTED' || error.code === 'ABORT_ERR'))
}
export async function searchImages(request: QoderImageSearchRequest, deps: ImageToolDependencies, signal?: AbortSignal): Promise<QoderImageSearchResult> {
  validateImageSearch(request)
  const requestId = randomUUID()
  const count = request.count ?? 5
  try {
    const parsed = await post('imageSearch', { payload: JSON.stringify({ query: Array.from(request.query).slice(0, 100).join(''), count }), encodeVersion: '1', requestId, timestamp: String(Math.floor(Date.now() / 1000)) }, deps, signal)
    return { requestId, results: items(parsed).slice(0, 1000).map(parseItem).filter((item): item is QoderImageSearchItem => item !== undefined).slice(0, count) }
  } catch (error) {
    signal?.throwIfAborted()
    if (error instanceof QoderImageSearchError || isImageSearchCancellation(error)) throw error
    const detail = record(error)
    const httpStatus = typeof detail?.httpStatus === 'number' ? detail.httpStatus : typeof detail?.statusCode === 'number' ? detail.statusCode : undefined
    const auth = ['AUTH', 'MISSING_CREDENTIAL', 'auth_required'].includes(String(detail?.code)) || httpStatus === 401 || httpStatus === 403
    throw new QoderImageSearchError(auth ? 'auth' : 'http', requestId, { httpStatus })
  }
}
/** Each download hop must connect only to verified public addresses. */
const privateNetworks = new BlockList()
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) privateNetworks.addSubnet(address, prefix, 'ipv4')
privateNetworks.addSubnet('2001::', 23, 'ipv6')
privateNetworks.addSubnet('2002::', 16, 'ipv6')
privateNetworks.addSubnet('2001:db8::', 32, 'ipv6')
privateNetworks.addSubnet('3fff::', 20, 'ipv6')
function publicAddress(address: string): boolean {
  if (isIP(address) === 4) return !privateNetworks.check(address, 'ipv4')
  return isIP(address) === 6 && /^[23]/u.test(address) && !privateNetworks.check(address, 'ipv6')
}
async function downloadUrl(raw: string, deps: ImageToolDependencies, signal: AbortSignal, onValidated?: (hostname: string) => void): Promise<{ url: string; addresses: readonly string[] }> {
  const diagnostic = inspectImageUrl(raw)
  if (diagnostic.rejection || diagnostic.protocol === 'data:') throw new Error('Unsafe image URL')
  const url = new URL(raw)
  onValidated?.(url.hostname)
  const hostname = url.hostname.replace(/^\[|\]$/gu, '')
  if (isIP(hostname)) {
    if (!publicAddress(hostname)) throw new Error('Unsafe image address')
    return { url: url.href, addresses: [hostname] }
  }
  const lookupAddresses = deps.resolveDownloadAddresses ?? (async (hostname: string) => (await lookup(hostname, { all: true, verbatim: true })).map(entry => entry.address))
  const addresses = await abortableImageOperation(lookupAddresses(url.hostname), signal)
  if (!addresses.length || addresses.some(address => !publicAddress(address))) throw new Error('Unsafe image address')
  return { url: url.href, addresses }
}
/** Connect to a checked address while preserving the original hostname/TLS SNI.
 * Native HTTP(S) never follows redirects and never performs another DNS lookup.
 */
export function pinnedDownload(url: string, init: RequestInit, addresses: readonly string[], requestImpl: typeof httpsRequest = new URL(url).protocol === 'http:' ? httpRequest : httpsRequest): Promise<Response> {
  return new Promise((resolve, reject) => {
    const address = addresses[0]
    if (!address || !publicAddress(address)) { reject(new Error('Unsafe image address')); return }
    const request = requestImpl(url, {
      method: 'GET',
      // Do not reuse a socket opened under another caller's DNS policy.
      agent: false,
      signal: init.signal ?? undefined,
      headers: { Accept: 'image/*', 'Accept-Encoding': 'identity' },
      lookup: (_hostname, options, callback) => {
        // Node may ask for all addresses for automatic family selection.
        if (options.all) callback(null, [{ address, family: isIP(address) }])
        else callback(null, address, isIP(address))
      },
    }, response => {
      const headers = new Headers()
      for (const [name, value] of Object.entries(response.headers)) {
        if (Array.isArray(value)) for (const item of value) headers.append(name, item)
        else if (value !== undefined) headers.set(name, value)
      }
      const status = response.statusCode ?? 502
      if ([204, 205, 304].includes(status)) {
        response.resume()
        resolve(new Response(null, { status, headers }))
      } else {
        resolve(new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>, { status, headers }))
      }
    })
    request.once('error', reject)
    request.end()
  })
}
function imageMediaType(bytes: Uint8Array): string {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (!b.length) throw new Error('Generated image is empty')
  if (b.length > maxImageBytes) throw new Error('Generated image exceeds 32 MiB limit')
  // Match CLI M$n's magic-byte checks, including AVIF's still/sequence brands.
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png'
  if (b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255) return 'image/jpeg'
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (b.length >= 6 && /^GIF8[79]a$/u.test(b.toString('ascii', 0, 6))) return 'image/gif'
  if (b.length >= 12 && b.toString('ascii', 4, 8) === 'ftyp' && ['avif', 'avis'].includes(b.toString('ascii', 8, 12))) return 'image/avif'
  throw new Error('Generated result is not a supported raster image')
}

/** Abort even when an injected DNS/download/stream implementation is stalled. */
function abortableImageOperation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
    if (signal.aborted) onAbort()
  })
}

function validateImageContentType(raw: string | null): void {
  if (!raw) return
  const type = raw.slice(0, raw.indexOf(';') < 0 ? raw.length : raw.indexOf(';')).trim().toLowerCase()
  if (!type.startsWith('image/') && !['application/octet-stream', 'binary/octet-stream'].includes(type)) throw new Error('Unsupported image content type')
}

function decodeImageDataUrl(raw: string): Uint8Array {
  if (raw.length > maxDataUrlCharacters) throw new Error('Generated image exceeds 32 MiB limit')
  const header = /^data:([^;,]+);base64,/iu.exec(raw)
  if (!header?.[1]) throw new Error('Invalid image data URL')
  validateImageContentType(header[1])
  const encoded = raw.slice(header[0].length).replace(/\s+/gu, '')
  if (encoded.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)) throw new Error('Invalid image base64 data')
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0
  if (Math.floor(3 * encoded.length / 4) - padding > maxImageBytes) throw new Error('Generated image exceeds 32 MiB limit')
  return new Uint8Array(Buffer.from(encoded, 'base64'))
}
export async function generateImage(request: QoderImageGenerationRequest, deps: ImageToolDependencies, signal?: AbortSignal): Promise<QoderImageGenerationResult> {
  validateImageGeneration(request)
  signal?.throwIfAborted()
  const requestId = randomUUID()
  const started = Date.now()
  let stage = 'credentials'
  let stageStarted = started
  let activeSignal = signal
  let receivedBytes = 0
  let status: number | undefined
  let urlDiagnostic: ReturnType<typeof inspectImageUrl> | undefined
  let failureLogged = false
  const debug = (event: string, details: Obj = {}) => deps.logger?.debug?.(`[Qoder Image] ${event}`, { requestId, region: deps.region, stage, durationMs: Date.now() - started, stageDurationMs: Date.now() - stageStarted, ...details })
  const begin = (next: string) => { stage = next; stageStarted = Date.now(); debug('Stage started') }
  const failure = (error: unknown) => {
    failureLogged = true
    deps.logger?.warn?.('[Qoder Image] Failed', {
      requestId, region: deps.region, stage, durationMs: Date.now() - started, stageDurationMs: Date.now() - stageStarted,
      status: error instanceof QoderLlmError ? error.httpStatus : status, receivedBytes, cancelled: signal?.aborted ?? false,
      timedOut: activeSignal?.aborted === true && activeSignal.reason?.name === 'TimeoutError',
      ...imageFailureDetails(error),
      ...urlDiagnostic ? { imageUrl: urlDiagnostic } : {},
    })
  }
  debug('Generation started', { startedAt: new Date(started).toISOString(), size: request.size ?? '1024x1024' })
  let imageUrl: string | undefined
  try {
    const credentials = await deps.resolveCredentials(signal)
    const identity = qoderTurnTracker.resolveTurnIdentity(request.sessionId === undefined ? undefined : JSON.stringify([deps.region, credentials.userID, request.sessionId]), [], request.hostRun ? 'conversation' : 'auxiliary', requestId, undefined, request.hostRun)
    const business = { product: 'cli', version: qoderIdeVersion, type: 'text2img', stage: identity.businessStage, id: identity.businessId, begin_at: identity.beginAt, name: request.prompt.slice(0, 30) }
    let parsed: Obj | undefined
    begin('generation')
    const generationTimeout = AbortSignal.timeout(deps.timeoutMs ?? 180_000)
    activeSignal = signal ? AbortSignal.any([signal, generationTimeout]) : generationTimeout
    try { parsed = record(await post('generateImage', { payload: JSON.stringify({ model: 'ge3i', prompt: request.prompt, size: request.size ?? '1024x1024', metadata: { business } }), encodeVersion: '1', sessionId: qoderSessionId(credentials.userID, request.sessionId), requestId }, deps, activeSignal, identity.requestSetId)) } catch (error) {
      failure(error)
      throw new QoderLlmError(`Qoder ImageGen did not confirm an outcome (request ${requestId}); do not automatically regenerate.`, 'PROVIDER_ERROR')
    }
    imageUrl = string(record(Array.isArray(parsed?.data) ? parsed.data[0] : undefined)?.url)
    debug('Generation completed', { hasImageUrl: !!imageUrl })
    if (!imageUrl) throw new QoderLlmError(`Qoder ImageGen returned no image URL (request ${requestId}); do not automatically regenerate.`, 'PROVIDER_ERROR')
    urlDiagnostic = inspectImageUrl(imageUrl)
    debug('Returned image URL', urlDiagnostic)
    let bytes: Uint8Array | undefined
    // Inline bytes never enter DNS or HTTP and are never included in diagnostics.
    if (/^data:/iu.test(imageUrl)) {
      activeSignal = signal
      activeSignal?.throwIfAborted()
      begin('data-url-decoding')
      bytes = decodeImageDataUrl(imageUrl)
      receivedBytes = bytes.length
      debug('Data URL decoded', { receivedBytes })
    } else {
      let nextUrl = imageUrl
      for (let redirects = 0; redirects <= maxImageRedirects; redirects++) {
        status = undefined
        // CLI gTu starts a new ten-minute download deadline for each hop.
        const timeout = AbortSignal.timeout(deps.downloadTimeoutMs ?? imageDownloadTimeoutMs)
        activeSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
        begin('url-dns-validation')
        activeSignal.throwIfAborted()
        urlDiagnostic = inspectImageUrl(nextUrl)
        const target = await downloadUrl(nextUrl, deps, activeSignal, hostname => {
          debug('URL validated', { hostname, passed: true, redirects })
          begin('dns-validation')
        })
        debug('URL and DNS validated', { hostname: new URL(target.url).hostname, addressCount: target.addresses.length, passed: true, redirects })
        begin('download')
        const response = await abortableImageOperation((deps.download ?? pinnedDownload)(target.url, { signal: activeSignal, redirect: 'manual', credentials: 'omit', headers: { Accept: 'image/*', 'Accept-Encoding': 'identity' } }, target.addresses), activeSignal)
        status = response.status
        const rawType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
        const contentType = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif', 'text/html', 'application/json', 'application/octet-stream', 'binary/octet-stream'].includes(rawType ?? '') ? rawType : rawType ? 'other' : undefined
        const rawLength = response.headers.get('content-length')
        const contentLength = rawLength !== null && /^\d{1,15}$/.test(rawLength) ? Number(rawLength) : undefined
        debug('Download response headers', { status, contentType, contentLength, redirects })
        if ([301, 302, 303, 307, 308].includes(status)) {
          const location = response.headers.get('location')
          await response.body?.cancel()
          begin('redirect-validation')
          if (!location) throw new Error('Image redirect is missing Location')
          if (redirects === maxImageRedirects) throw new Error('Generated image exceeded 5 redirects')
          try { nextUrl = new URL(location, target.url).href } catch { throw new Error('Invalid image redirect URL') }
          urlDiagnostic = inspectImageUrl(nextUrl)
          if (urlDiagnostic.rejection || urlDiagnostic.protocol === 'data:') throw new Error('Unsafe image redirect URL')
          debug('Following redirect', { redirects: redirects + 1, imageUrl: urlDiagnostic })
          continue
        }
        try {
          if (!response.ok) throw new Error('Image download rejected')
          validateImageContentType(response.headers.get('content-type'))
          if (Number(response.headers.get('content-length')) > maxImageBytes) throw new Error('Generated image exceeds 32 MiB limit')
          if (!response.body) throw new Error('Generated image is empty')
          const reader = response.body.getReader()
          const chunks: Uint8Array[] = []
          let length = 0
          try {
            while (true) {
              activeSignal.throwIfAborted()
              const chunk = await abortableImageOperation(reader.read(), activeSignal)
              if (chunk.done) break
              length += chunk.value.length
              receivedBytes = length
              if (length > maxImageBytes) throw new Error('Generated image exceeds 32 MiB limit')
              chunks.push(chunk.value)
            }
          } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
          bytes = new Uint8Array(Buffer.concat(chunks, length))
        } finally { await response.body?.cancel().catch(() => {}) }
        debug('Download completed', { receivedBytes, redirects })
        break
      }
    }
    if (!bytes) throw new Error('Image download rejected')
    begin('image-validation')
    const mediaType = imageMediaType(bytes)
    debug('Image validated', { mediaType, receivedBytes })
    return { bytes, mediaType, requestId, imageUrl }
  } catch (error) {
    // Generation errors already logged above retain their existing public message.
    if (!failureLogged) failure(error)
    if (imageUrl) throw new QoderImageDeliveryError(requestId, imageUrl, error)
    throw error
  }
}
