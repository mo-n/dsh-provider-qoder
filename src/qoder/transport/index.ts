/** The only external seam for communication with Qoder. */

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { QoderAccountInfo } from '../account.ts'
import type { QoderCatalogModel } from '../catalog.ts'
import type { QoderRegion } from '../region.ts'
import { DefaultQoderTransport, defaultStreamIdleTimeoutMs } from './default-transport.ts'
import type { QoderLogger } from './logging.ts'

export { defaultStreamIdleTimeoutMs }

export interface QoderTransport {
  stream(options: GenerateOptions, model?: QoderCatalogModel): AsyncIterable<StreamChunk>
  discoverModels(signal?: AbortSignal): Promise<readonly QoderCatalogModel[]>
  readAccount(options?: { force?: boolean; signal?: AbortSignal }): Promise<QoderAccountInfo>
}

export interface QoderTransportOptions {
  region: QoderRegion
  resolvePat: () => Promise<string>
  fetch?: typeof fetch
  logger?: QoderLogger
  streamIdleTimeoutMs?: number
  responseHeaderTimeoutMs?: number
  metadataTimeoutMs?: number
  resolveMachineId?: () => string
  attachments?: Pick<AttachmentStore, 'imageLimits' | 'readImageRequest'>
}

export function createQoderTransport(options: QoderTransportOptions): QoderTransport {
  return new DefaultQoderTransport(options)
}
