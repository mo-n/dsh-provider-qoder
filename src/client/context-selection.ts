import { QODER_PROVIDER_ID } from '../dsh/provider.ts'
import type { QoderRegion } from '../qoder/region.ts'
import type { QoderCredentialOperations } from './credential-operations.ts'

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

/** Composer selections belong to the current session; model defaults live in settings. */
export async function saveContextSelection(
  operations: Pick<QoderCredentialOperations, 'setSessionTier'>,
  sessionId: string,
  region: QoderRegion,
  modelId: string,
  tierKey: string,
): Promise<'saved' | 'session-failed'> {
  try {
    return await operations.setSessionTier?.(sessionId, modelId, tierKey, region) ? 'saved' : 'session-failed'
  } catch {
    return 'session-failed'
  }
}
