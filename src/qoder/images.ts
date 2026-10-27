import type { QoderHostRun } from './turn.ts'

export interface QoderImageSearchRequest {
  query: string
  count?: number
}

export interface QoderImageSearchItem {
  title?: string
  imageUrl?: string
  thumbnailUrl?: string
  sourceUrl?: string
  hostname?: string
  width?: number
  height?: number
}

export interface QoderImageSearchResult {
  results: QoderImageSearchItem[]
  requestId: string
}

export type QoderImageSearchFailureReason = 'auth' | 'http' | 'parse' | 'backend'

/** Search failures retain safe protocol diagnostics without upstream response text. */
export class QoderImageSearchError extends Error {
  readonly code = 'IMAGE_SEARCH_FAILED'
  readonly reason: QoderImageSearchFailureReason
  readonly requestId: string
  readonly httpStatus?: number
  readonly upstreamCode?: string

  constructor(reason: QoderImageSearchFailureReason, requestId: string, details: { httpStatus?: number; upstreamCode?: string } = {}) {
    // Free-form business strings may contain credentials; preserve bounded numeric codes only.
    const upstreamCode = details.upstreamCode && /^-?\d{1,16}$/u.test(details.upstreamCode) ? details.upstreamCode : undefined
    super(`Qoder image search failed (${reason}${details.httpStatus === undefined ? '' : `; HTTP ${details.httpStatus}`}${upstreamCode === undefined ? '' : `; code ${upstreamCode}`}); requestId=${requestId}.`)
    this.name = 'QoderImageSearchError'
    this.reason = reason
    this.requestId = requestId
    this.httpStatus = details.httpStatus
    this.upstreamCode = upstreamCode
  }
}

export interface QoderImageGenerationRequest {
  prompt: string
  size?: string
  sessionId?: string
  hostRun?: QoderHostRun
}

export interface QoderImageGenerationResult {
  bytes: Uint8Array
  mediaType: string
  requestId: string
  imageUrl: string
}

/** Generation succeeded: retry delivery, never generation.
 * imageUrl may contain a signed credential; never log it.
 */
export class QoderImageDeliveryError extends Error {
  readonly requestId: string
  declare readonly imageUrl: string

  constructor(requestId: string, imageUrl: string, cause?: unknown) {
    super(`Qoder image was generated but delivery failed: ${imageFailureDetails(cause).reason}. Do not regenerate; retry delivery (request ${requestId}).`)
    this.name = 'QoderImageDeliveryError'
    this.requestId = requestId
    Object.defineProperty(this, 'cause', { value: cause, enumerable: false })
    Object.defineProperty(this, 'imageUrl', { value: imageUrl, enumerable: false })
  }
}

/** Only known codes and local reasons are safe; arbitrary messages may contain signed URLs. */
export function imageFailureDetails(error: unknown): { reason: string; errorCode?: string } {
  const reasons = new Set(['Unsafe image URL', 'Unsafe image address', 'Image DNS resolution interrupted', 'Image download rejected', 'Generated image exceeds 32 MiB limit', 'Generated image is empty', 'Generated result is not a supported raster image', 'Unsupported image content type', 'Invalid image data URL', 'Invalid image base64 data', 'Image redirect is missing Location', 'Invalid image redirect URL', 'Unsafe image redirect URL', 'Generated image exceeded 5 redirects'])
  const codes = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'EPIPE', 'EPROTO', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID', 'ABORT_ERR', 'ENOSPC', 'EACCES', 'EPERM'])
  let current = error
  let errorCode: string | undefined
  for (let depth = 0; current instanceof Error && depth < 4; depth++) {
    const code = 'code' in current ? current.code : undefined
    if (typeof code === 'string' && codes.has(code)) { errorCode = code; break }
    current = current.cause
  }
  const reason = error instanceof Error && error.name === 'TimeoutError' ? 'Image delivery timed out'
    : error instanceof Error && error.name === 'AbortError' ? 'Image delivery cancelled'
      : error instanceof Error && reasons.has(error.message) ? error.message : 'Operation failed'
  return { reason, ...errorCode ? { errorCode } : {} }
}
