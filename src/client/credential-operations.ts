import type { QoderModelCatalogEditor } from './model-catalog-editor.ts'
import type { OperationResult } from './operation-result.ts'
import type { QoderAccountInfo } from '../qoder/account.ts'
import { defaultModels, type QoderCatalogModel } from '../qoder/catalog.ts'
import type { QoderRegion } from '../qoder/region.ts'
import type { QoderWebSearchMode } from '../dsh/config.ts'
import type { QoderCatalogEdit, QoderCatalogStatus, QoderSessionTierScope, QoderSessionTierSelection, QoderRpcResult } from '../dsh/rpc-channel.ts'
import type { QoderCredentialCopy } from './locales.ts'
import type { QoderAuthorizationView } from '../qoder/authorization.ts'

export interface QoderAuthorizationOperations {
  read(region: QoderRegion): Promise<QoderRpcResult<QoderAuthorizationView>>
  begin(region: QoderRegion): Promise<QoderRpcResult<QoderAuthorizationView>>
  cancel(region: QoderRegion): Promise<QoderRpcResult<QoderAuthorizationView>>
  select(region: QoderRegion, method: 'pat' | 'browser' | 'none'): Promise<QoderRpcResult<QoderAuthorizationView>>
}

export interface QoderCredentialOperations {
  authorization?: QoderAuthorizationOperations
  describePat?(): Promise<OperationResult<QoderCredentialStatus>>
  describe(): Promise<OperationResult<QoderCredentialStatus>>
  store(value: string): Promise<OperationResult<void>>
  remove(): Promise<OperationResult<void>>
  getAccount(force?: boolean): Promise<QoderAccountResult | undefined>
  getModelSnapshot(): QoderModelSettingsSnapshot
  subscribeModels(listener: () => void): () => void
  storeModels(region: QoderRegion, models: QoderCatalogModel[]): Promise<OperationResult<void>>
  storeRegion(region: QoderRegion): Promise<OperationResult<void>>
  storeWebSearchMode(mode: QoderWebSearchMode): Promise<OperationResult<void>>
  storeImageSearchEnabled(enabled: boolean): Promise<OperationResult<void>>
  storeImageGenEnabled(enabled: boolean): Promise<OperationResult<void>>
  getCatalogEditor?(region: QoderRegion, models: readonly QoderCatalogModel[]): QoderModelCatalogEditor
  refreshCatalog?(region: QoderRegion): Promise<QoderRpcResult<readonly QoderCatalogModel[]>>
  editCatalog?(region: QoderRegion, edit: QoderCatalogEdit): Promise<QoderRpcResult<readonly QoderCatalogModel[]>>
  subscribeCatalog?(region: QoderRegion, listener: (status?: QoderCatalogStatus) => void): () => void
  setSessionTier?(sessionId: string, modelId: string, tierKey: string, region: QoderRegion): Promise<OperationResult<QoderSessionTierSelection>>
  readSessionTier?(scope: QoderSessionTierScope): Promise<OperationResult<QoderSessionTierSelection>>
  subscribeSessionTiers?(scope: QoderSessionTierScope, listener: () => void): () => void
  subscribe(listener: () => void): () => void
}

export interface QoderModelSettingsSection {
  region?: QoderRegion
  modelsByRegion?: Partial<Record<QoderRegion, QoderCatalogModel[]>>
  webSearchMode?: QoderWebSearchMode
  imageSearchEnabled?: boolean
  imageGenEnabled?: boolean
  showModelRates?: boolean
}

export function regionOf(value: unknown): QoderRegion {
  if (typeof value !== 'object' || value === null) return 'global'
  return (value as { region?: unknown }).region === 'china' ? 'china' : 'global'
}

export function modelsOf(section: QoderModelSettingsSection | undefined, region: QoderRegion): QoderCatalogModel[] {
  const scoped = section?.modelsByRegion?.[region]
  return Array.isArray(scoped) ? scoped : defaultModels.map(model => ({ ...model }))
}

export interface QoderModelSettingsSnapshot {
  status: 'loading' | 'ready' | 'unavailable'
  value: QoderModelSettingsSection | undefined
  base: unknown
  user: unknown
  revision: number | undefined
  writable: boolean
  mode?: 'host' | 'memory'
}

export interface QoderCredentialStatus {
  configured: boolean
  source?: string
  writable: boolean
}

export type QoderAccountResult = QoderRpcResult<QoderAccountInfo>

export interface QoderCredentialInjected {
  operations: QoderCredentialOperations
  t(key: QoderCredentialCopy, values?: Record<string, string | number>): string
  /**
   * Read the active UI locale at render time so a language switch is reflected
   * immediately; never snapshot it once during plugin setup.
   */
  activeLocale(): string
}
