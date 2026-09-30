import { contextTiersOf } from '../qoder/catalog.ts'
import { QODER_PROVIDER_ID } from '../dsh/provider.ts'
import type { QoderRegion } from '../qoder/region.ts'
import { modelsOf, type QoderCredentialOperations } from './credential-operations.ts'

export function isQoderProvider(provider?: string): boolean {
  return [QODER_PROVIDER_ID, 'qoder-official', 'qoder', 'qoder-subscription'].includes(provider ?? '')
}

export interface ModelIdentity {
  provider?: string
  model?: string
}

export function historicalContextWindow(current: ModelIdentity, lastUsed: ModelIdentity | null | undefined, contextWindow?: number): number | undefined {
  return current.provider === lastUsed?.provider && current.model === lastUsed?.model ? contextWindow : undefined
}

/** A failed session write must not change defaults; a failed default write is a partial success. */
export async function saveContextSelection(
  operations: Pick<QoderCredentialOperations, 'setSessionTier' | 'storeModels' | 'getModelSnapshot'>,
  sessionId: string,
  region: QoderRegion,
  modelId: string,
  tierKey: string,
): Promise<'saved' | 'session-failed' | 'default-failed'> {
  try {
    if (!await operations.setSessionTier?.(sessionId, modelId, tierKey, region)) return 'session-failed'
  } catch {
    return 'session-failed'
  }
  try {
    const models = modelsOf(operations.getModelSnapshot().value, region)
    const model = models.find(candidate => candidate.id === modelId)
    const tier = model && contextTiersOf(model).find(candidate => candidate.key === tierKey)
    if (!tier) return 'default-failed'
    const updated = models.map(candidate => candidate.id === modelId
      ? { ...candidate, contextTier: tierKey, contextWindow: tier.tokenCount }
      : candidate)
    return await operations.storeModels(region, updated) ? 'saved' : 'default-failed'
  } catch {
    return 'default-failed'
  }
}
