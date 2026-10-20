/** The only external seam for communication with Qoder. */

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { QoderAccountInfo } from '../account.ts'
import type { QoderCatalogModel } from '../catalog.ts'
import type { QoderRegion } from '../region.ts'
import { DefaultQoderTransport, defaultStreamIdleTimeoutMs } from './default-transport.ts'
import { defaultResponseHeaderTimeoutMs } from './request.ts'
import type { QoderQueueOwner, QoderQueueUpdate } from '../queue.ts'
import type { QoderLogger } from './logging.ts'
import type { QoderAuthorizationTransport, QoderCredentialLease } from '../authorization.ts'

import type { WebSearchRequest, WebSearchResult } from '@deepseek-ai/dsh-web'

export { defaultResponseHeaderTimeoutMs, defaultStreamIdleTimeoutMs }
export type QoderModelTransport = 'http' | 'legacy'

export interface QoderTransport {
  /** Optional on third-party test transports; always present on the default transport. */
  authorization?: QoderAuthorizationTransport
  stream(options: GenerateOptions, model?: QoderCatalogModel): AsyncIterable<StreamChunk>
  discoverModels(signal?: AbortSignal): Promise<readonly QoderCatalogModel[]>
  readAccount(options?: { force?: boolean; signal?: AbortSignal }): Promise<QoderAccountInfo>
  searchWeb(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult>
}

export interface QoderTransportOptions {
  region: QoderRegion
  modelQueueMaxWaitMs?: number
  onQueueUpdate?: (update: QoderQueueUpdate) => void
  /** Capture the current host run before I/O; reject late leases after its boundary closes. */
  captureQueueLeaseOwner?: (sessionId: string) => QoderQueueOwner | undefined
  modelTransport?: QoderModelTransport
  resolvePat: () => Promise<string>
  /** Resolve an instance-managed browser authorization; undefined retains legacy PAT behavior. */
  resolveCredential?: (signal?: AbortSignal) => Promise<QoderCredentialLease | undefined>
  fetch?: typeof fetch
  logger?: QoderLogger
  streamIdleTimeoutMs?: number
  responseHeaderTimeoutMs?: number
  metadataTimeoutMs?: number
  resolveMachineId?: () => string
  attachments?: Pick<AttachmentStore, 'imageLimits' | 'readImageRequest'>
  /** Deadline for one center image publication attempt. */
  imageUploadTimeoutMs?: number
  /** Lifetime of a remembered center image URL. */
  imageUrlCacheTtlMs?: number
  /** Whether prior assistant reasoning content is preserved across turns. */
  preserveThinking?: boolean
}

export function createQoderTransport(options: QoderTransportOptions): QoderTransport {
  return new DefaultQoderTransport(options)
}

export { QoderSearchClient } from './search.ts'
export type { QoderSearchClientOptions } from './search.ts'

