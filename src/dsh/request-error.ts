/** A confirmed invalid local caller parameter, distinct from upstream rejections. */
import { QoderLlmError } from '../qoder/errors.ts'

export class QoderRequestError extends QoderLlmError {
  constructor(message: string) { super(message, 'INVALID_REQUEST') }
}

/** An advertised tier disappeared before the host could commit a catalog edit. */
export class QoderCatalogTierUnavailableError extends QoderLlmError {
  readonly modelIds: readonly string[]
  constructor(modelIds: readonly string[]) {
    super('A Qoder context tier is no longer available.', 'CATALOG_TIER_UNAVAILABLE')
    this.modelIds = modelIds
  }
}
