import type { QoderAccountInfo } from '../usage.ts'
import type { QoderCatalogModel } from '../adapter.ts'
import type { QoderRegion } from '../endpoints.ts'
import type { QoderCredentialCopy } from './locales.ts'

export interface QoderCredentialOperations {
  describe(): Promise<QoderCredentialStatus | undefined>
  store(value: string): Promise<boolean>
  remove(): Promise<boolean>
  getAccount(force?: boolean): Promise<QoderAccountResult | undefined>
  getModelSnapshot(): QoderModelSettingsSnapshot
  subscribeModels(listener: () => void): () => void
  storeModels(models: QoderCatalogModel[]): Promise<boolean>
  storeRegion(region: QoderRegion): Promise<boolean>
  discoverModels(): Promise<QoderModelDiscoveryResult>
  subscribe(listener: () => void): () => void
}

export interface QoderModelSettingsSection {
  region?: QoderRegion
  models?: QoderCatalogModel[]
}


export interface QoderModelSettingsSnapshot {
  status: 'loading' | 'ready' | 'unavailable'
  value: QoderModelSettingsSection | undefined
  base: unknown
  user: unknown
  revision: number | undefined
  writable: boolean
  mode: 'host' | 'memory'
}

export type QoderModelDiscoveryResult =
  | { ok: true; data: QoderCatalogModel[] }
  | { ok: false; error?: string }

export interface QoderModelReconciliation {
  catalog: QoderCatalogModel[]
  selected: QoderCatalogModel[]
  unavailableIds: Set<string>
}

export function reconcileQoderModels(
  known: readonly QoderCatalogModel[],
  discovered: readonly QoderCatalogModel[],
): QoderModelReconciliation {
  const availableIds = new Set(discovered.map(model => model.id))
  const unavailable = known.filter(model => !availableIds.has(model.id))
  return {
    catalog: [...discovered, ...unavailable],
    selected: [...discovered],
    unavailableIds: new Set(unavailable.map(model => model.id)),
  }
}

export interface QoderCredentialStatus {
  configured: boolean
  source?: string
  writable: boolean
}

export type QoderAccountResult =
  | { ok: true; data: QoderAccountInfo }
  | { ok: false; error?: string }

export interface QoderCredentialInjected {
  operations: QoderCredentialOperations
  t(key: QoderCredentialCopy, values?: Record<string, string | number>): string
}
