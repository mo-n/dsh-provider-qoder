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

  constructor(requestId: string, imageUrl: string) {
    super(`Qoder image was generated but delivery failed. Do not regenerate; retry delivery (request ${requestId}).`)
    this.name = 'QoderImageDeliveryError'
    this.requestId = requestId
    Object.defineProperty(this, 'imageUrl', { value: imageUrl, enumerable: false })
  }
}
