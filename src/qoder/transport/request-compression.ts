/** qodercli-compatible request compression and endpoint capability recovery. */
import * as zlib from 'node:zlib'
import { promisify } from 'node:util'
import { QoderLlmError } from '../errors.ts'
import type { QoderLogger } from './logging.ts'

type Protocol = 'http' | 'legacy'
type Rejection = 'unsupported_encoding' | 'invalid_json_at_origin' | 'signature_invalid'
export interface QoderCompressionRejection {
  status: number
  contentType: string | null
  serverRequestId?: string
  body: string
  bodyTruncated: boolean
  probeTimedOut: boolean
  reason?: Rejection
}
// Process-local, protocol + origin + path; never persist subscriber information.
const disabledEndpoints = new Set<string>()

function endpointKey(protocol: Protocol, url: string): string {
  const { origin, pathname } = new URL(url)
  return `${protocol}:${origin}${pathname}`
}

function vpcEndpoint(url: string): boolean {
  const host = new URL(url).hostname.toLowerCase().replace(/\.$/u, '')
  return host === 'vpc.qoder.com.cn' || host.endsWith('.vpc.qoder.com.cn')
}

function envBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined
  if (['true', '1'].includes(value.trim().toLowerCase())) return true
  if (['false', '0'].includes(value.trim().toLowerCase())) return false
  return undefined
}

function envInteger(value: string | undefined, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  if (value === undefined || !value.trim()) return fallback
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= max ? parsed : fallback
}

export function compressionRejection(status: number, text: string, protocol: Protocol): Rejection | undefined {
  if (status === 415 && /zstd|content[- ]encoding|compressed (?:request|body)/iu.test(text)) return 'unsupported_encoding'
  if (status === 400 && /invalid.*json|invalid character|parse.*json|unexpected token|not valid json/iu.test(text)
    && /\\x28|\\u0028|0x28|(?:character|token)\s*['"]\(['"]/iu.test(text)) return 'invalid_json_at_origin'
  if (protocol === 'legacy' && status === 403) {
    let payload: unknown
    try { payload = JSON.parse(text) } catch { return undefined }
    if (payload && typeof payload === 'object') {
      const root = payload as Record<string, unknown>
      const error = root.error && typeof root.error === 'object' ? root.error as Record<string, unknown> : root
      if (String(error.code) === '101' && /signature (?:is )?invalid/iu.test(text)) return 'signature_invalid'
    }
  }
  return undefined
}

/** Probe only rejection responses, without consuming the transport's response. */
async function probe(response: Response, protocol: Protocol, signal: AbortSignal): Promise<QoderCompressionRejection | undefined> {
  if (![400, 403, 415].includes(response.status)) return undefined
  const reader = response.clone().body?.getReader()
  if (!reader) return undefined
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(1000)])
  const decoder = new TextDecoder()
  let remaining = 8192
  let text = ''
  let truncated = false
  const interrupted = (): void => { void reader.cancel().catch(() => undefined) }
  deadline.addEventListener('abort', interrupted, { once: true })
  try {
    if (deadline.aborted) return undefined
    while (remaining > 0 && !deadline.aborted) {
      const { value, done } = await reader.read()
      if (done) break
      if (value.byteLength >= remaining) truncated = true
      text += decoder.decode(value.subarray(0, remaining), { stream: true })
      remaining -= Math.min(value.byteLength, remaining)
      try { JSON.parse(text); break } catch { /* Continue a bounded diagnostic. */ }
    }
    text += decoder.decode()
    return {
      status: response.status, contentType: response.headers.get('content-type'),
      serverRequestId: response.headers.get('x-request-id') ?? undefined,
      body: text, bodyTruncated: truncated, probeTimedOut: deadline.aborted,
      reason: deadline.aborted ? undefined : compressionRejection(response.status, text, protocol),
    }
  } catch { return undefined }
  finally {
    deadline.removeEventListener('abort', interrupted)
    // A tee branch's cancellation can wait for the original response consumer.
    void reader.cancel().catch(() => undefined)
  }
}

/** One instance per prepared model request; endpoint decisions survive requests. */
export class QoderRequestCompression {
  private fallbackAttempted = false
  private pendingConfirmation?: string
  private compressedEndpoint?: string
  diagnostics?: { encoding: string; originalBytes: number; sentBytes: number; reason?: string }

  async send(options: {
    url: string; protocol: Protocol; body: string; headers: Record<string, string>
    enabled?: boolean; signal: AbortSignal; logger?: QoderLogger; requestId: string
    onRejection?: (rejection: QoderCompressionRejection) => Promise<void>
    dispatch: (body: string | Uint8Array<ArrayBuffer>, headers: Record<string, string>) => Promise<Response>
  }): Promise<Response> {
    const { url, protocol, body, headers, signal, logger, requestId } = options
    let identityReason: string | undefined
    const dispatch = (wireBody: string | Uint8Array<ArrayBuffer>, wireHeaders: Record<string, string>): Promise<Response> => {
      this.diagnostics = {
        encoding: new Headers(wireHeaders).get('content-encoding') ?? 'identity',
        originalBytes: Buffer.byteLength(body),
        sentBytes: typeof wireBody === 'string' ? Buffer.byteLength(wireBody) : wireBody.byteLength,
        ...identityReason === undefined ? {} : { reason: identityReason },
      }
      logger?.debug?.('[Qoder Request] Dispatch', { requestId, protocol, ...this.diagnostics })
      return options.dispatch(wireBody, wireHeaders)
    }
    signal.throwIfAborted()
    const enabled = envBoolean(process.env.QODER_ZSTD_REQUEST_BODIES) ?? options.enabled ?? true
    const key = endpointKey(protocol, url)
    const minChars = envInteger(process.env.QODER_ZSTD_REQUEST_BODY_MIN_CHARS, 4096)
    const level = envInteger(process.env.QODER_ZSTD_REQUEST_BODY_LEVEL, 1, 22)
    const existingEncoding = new Headers(headers).get('content-encoding')
    identityReason = !enabled ? 'disabled'
      : this.fallbackAttempted ? 'fallback_already_attempted'
        : vpcEndpoint(url) ? 'vpc_endpoint'
          : disabledEndpoints.has(key) ? 'endpoint_disabled'
            : body.length < minChars ? 'below_threshold'
              : typeof zlib.zstdCompress !== 'function' || zlib.constants.ZSTD_c_compressionLevel === undefined ? 'native_unavailable'
                : existingEncoding && existingEncoding !== 'identity' ? 'existing_encoding' : undefined
    if (identityReason) return dispatch(body, headers)
    let compressed: Buffer
    const original = Buffer.from(body, 'utf8')
    try {
      compressed = await promisify(zlib.zstdCompress)(original, {
        params: { [zlib.constants.ZSTD_c_compressionLevel]: level },
      })
    } catch {
      signal.throwIfAborted()
      identityReason = 'compression_error'
      logger?.warn?.('[Qoder Request] Zstd compression failed; sending identity', { requestId, protocol })
      return dispatch(body, headers)
    }
    signal.throwIfAborted()
    if (compressed.byteLength >= original.byteLength) {
      identityReason = 'not_smaller'
      return dispatch(body, headers)
    }
    const identityHeaders = Object.fromEntries(Object.entries(headers).filter(([key]) =>
      !['content-length', 'content-encoding'].includes(key.toLowerCase())))
    logger?.debug?.('[Qoder Request] Sending zstd', {
      requestId, protocol, originalBytes: original.byteLength, compressedBytes: compressed.byteLength, level,
    })
    this.compressedEndpoint = key
    const response = await dispatch(new Uint8Array(compressed), { ...identityHeaders, 'Content-Encoding': 'zstd' })
    const rejection = await probe(response, protocol, signal)
    signal.throwIfAborted()
    if (rejection && options.onRejection) {
      try { await options.onRejection(rejection) }
      catch { logger?.warn?.('[Qoder Request] Compression rejection capture failed', { requestId, protocol, status: response.status }) }
    }
    signal.throwIfAborted()
    if (!rejection?.reason) return response
    if (protocol === 'legacy') {
      void response.body?.cancel().catch(() => undefined)
      this.rejectLegacy(response.status, rejection.reason)
    }
    this.fallbackAttempted = true
    identityReason = rejection.reason
    logger?.debug?.('[Qoder Request] Retrying identity', { requestId, protocol, reason: rejection.reason, status: response.status })
    void response.body?.cancel().catch(() => undefined)
    const identityResponse = await dispatch(body, identityHeaders)
    this.pendingConfirmation = key
    return identityResponse
  }

  confirm(): void {
    if (this.pendingConfirmation) disabledEndpoints.add(this.pendingConfirmation)
    this.pendingConfirmation = undefined
    this.compressedEndpoint = undefined
  }

  /** Legacy may reject the encoding in its SSE envelope before model output. */
  rejectLegacyError(error: unknown): void {
    if (!(error instanceof QoderLlmError) || !this.compressedEndpoint) return
    const status = error.failure.status
    const cause = error.cause
    if (typeof status !== 'number') return
    const text = typeof cause === 'string' ? cause : JSON.stringify(cause) ?? ''
    const rejection = compressionRejection(status, text, 'legacy')
    if (rejection) this.rejectLegacy(status, rejection)
  }

  private rejectLegacy(status: number, reason: Rejection): never {
    if (this.compressedEndpoint) disabledEndpoints.add(this.compressedEndpoint)
    // DSH retries with a new request identity. Never replay a model stream here.
    throw new QoderLlmError(`Qoder rejected Zstd (${reason}); retry without compression.`, 'TRANSPORT', { status })
  }
}
