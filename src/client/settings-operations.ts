import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import { qoderCredentialRef } from '../dsh/credential-contract.ts'
import type { QoderSessionTierScope, QoderSessionTierSelection } from '../dsh/rpc-channel.ts'
import type { QoderRegion } from '../qoder/region.ts'
import type { QoderAuthorizationOperations, QoderCredentialStatus, QoderModelSettingsSnapshot } from './credential-operations.ts'
import { regionOf } from './credential-operations.ts'
import { failure, operationCause, success, type OperationResult } from './operation-result.ts'
import type { QoderRpcCaller } from './rpc-client.ts'

export interface ModelForm {
  getSnapshot(): QoderModelSettingsSnapshot
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<boolean | void>
  mutate(ops: readonly SettingsPathOpView[]): Promise<boolean | void>
}
type RemoteResponse<T> = { ok: true; value: T } | { ok: false; error: { code?: string; message?: string; status?: number } }
export interface QoderCredentialsRemote {
  describe(refs: string[]): Promise<RemoteResponse<Record<string, QoderCredentialStatus>>>
  set(ref: string, value: string): Promise<RemoteResponse<unknown>>
  unset(ref: string): Promise<RemoteResponse<unknown>>
}

/** Client storage adapters; host/Qoder protocol access remains in the existing RPC. */
export function createSettingsOperations(credentials: QoderCredentialsRemote, form: ModelForm, authorization: QoderAuthorizationOperations, rpc: QoderRpcCaller) {
  const rejectedOutcome = (error: unknown) => ['permission-denied', 'unauthenticated', 'persistence'].includes(operationCause(error)) ? 'not-completed' as const : 'unknown' as const
  const describePat = async (): Promise<OperationResult<QoderCredentialStatus>> => {
    try {
      const response = await credentials.describe([qoderCredentialRef])
      if (!response.ok) return failure('describePat', 'read-pat', response.error)
      const value = response.value[qoderCredentialRef]
      return value ? success(value) : failure('describePat', 'read-pat', undefined)
    } catch (error) { return failure('describePat', 'read-pat', error) }
  }
  const setting = async (operation: string, write: () => Promise<boolean | void>) => {
    try {
      const result = await write()
      if (result !== false) return success(undefined)
      return failure(operation, 'persist-settings', undefined, { mutation: true })
    } catch (error) {
      // getSnapshot is a local view, potentially optimistic. It cannot confirm persistence.
      return failure(operation, 'persist-settings', error, { mutation: true })
    }
  }
  const readTier = (scope: QoderSessionTierScope) => rpc.call('readSessionTier', scope)
  return {
    describePat,
    describe: async (): Promise<OperationResult<QoderCredentialStatus>> => {
      try {
        const result = await authorization.read(regionOf(form.getSnapshot().value))
        return result.ok ? success({ configured: result.value.configured && !result.value.expired,
          source: result.value.method, writable: result.value.writable }) : failure('describe', 'read-authorization', result.error)
      } catch (error) { return failure('describe', 'read-authorization', error) }
    },
    store: async (value: string): Promise<OperationResult<void>> => {
      let region: QoderRegion | undefined
      let saved = false
      let stage = 'read-settings'
      try {
        region = regionOf(form.getSnapshot().value)
        stage = 'persist-pat'
        const response = await credentials.set(qoderCredentialRef, value.trim())
        if (!response.ok) return failure('storePat', stage, response.error, { mutation: true, outcome: rejectedOutcome(response.error), context: { region } })
        saved = true
        stage = 'read-authorization'
        const current = await authorization.read(region)
        if (!current.ok) return failure('storePat', stage, current.error, { mutation: true, completedStages: ['persist-pat'] })
        if (current.value.method === 'pat') return success(undefined)
        stage = 'select-authorization'
        let selectionError: unknown
        try {
          const selected = await authorization.select(region, 'pat')
          if (selected.ok) return success(undefined)
          selectionError = selected.error
        } catch (error) { selectionError = error }
        // Reconcile a possibly accepted selection without replaying either write.
        const reconciled = await authorization.read(region).catch(() => undefined)
        if (reconciled?.ok && reconciled.value.method === 'pat') return success(undefined)
        return failure('storePat', stage, selectionError, { mutation: true, completedStages: ['persist-pat'], context: { region } })
      } catch (error) {
        // A configured PAT cannot identify the value just submitted: never read plaintext.
        return failure('storePat', stage, error, { mutation: true, completedStages: saved ? ['persist-pat'] : [], ...stage === 'read-settings' ? { outcome: 'not-completed' as const } : {}, context: { region } })
      }
    },
    remove: async (): Promise<OperationResult<void>> => {
      let error: unknown
      try {
        const response = await credentials.unset(qoderCredentialRef)
        if (response.ok) return success(undefined)
        error = response.error
        if (rejectedOutcome(error) === 'not-completed') return failure('removePat', 'remove-pat', error, { mutation: true, outcome: 'not-completed' })
      }
      catch (caught) { error = caught }
      // Status can confirm absence, but cannot confirm a newly saved PAT's identity.
      try {
        const response = await credentials.describe([qoderCredentialRef])
        if (response.ok && response.value[qoderCredentialRef]?.configured === false) return success(undefined)
      } catch { /* Retain the original failure and uncertainty. */ }
      return failure('removePat', 'remove-pat', error, { mutation: true })
    },
    storeModels: (region: QoderRegion, models: unknown[]) => setting('storeModels', () => form.mutate([{
      op: 'set', path: ['modelsByRegion', region], value: JSON.parse(JSON.stringify(models)),
    }])),
    storeRegion: (region: QoderRegion) => setting('storeRegion', () => form.set('region', region)),
    storeWebSearchMode: (mode: import('../dsh/config.ts').QoderWebSearchMode) => setting('storeWebSearchMode', () => form.set('webSearchMode', mode)),
    storeImageSearchEnabled: (enabled: boolean) => setting('storeImageSearchEnabled', () => form.set('imageSearchEnabled', enabled)),
    storeImageGenEnabled: (enabled: boolean) => setting('storeImageGenEnabled', () => form.set('imageGenEnabled', enabled)),
    readSessionTier: async (scope: QoderSessionTierScope): Promise<OperationResult<QoderSessionTierSelection>> => {
      try { const result = await readTier(scope); return result.ok ? result : failure('readSessionTier', 'read-context-tier', result.error, { context: scope }) }
      catch (error) { return failure('readSessionTier', 'read-context-tier', error, { context: scope }) }
    },
    setSessionTier: async (sessionId: string, modelId: string, tierKey: string, region: QoderRegion): Promise<OperationResult<QoderSessionTierSelection>> => {
      const scope = { sessionId, modelId, region }
      let error: unknown
      try {
        const result = await rpc.call('sessionTier', { ...scope, tierKey })
        if (result.ok) return result
        error = result.error
        if (rejectedOutcome(error) === 'not-completed') return failure('setSessionTier', 'persist-context-tier', error, { mutation: true, outcome: 'not-completed', context: { ...scope, tierKey } })
      }
      catch (caught) { error = caught }
      try {
        const current = await readTier(scope)
        if (current.ok && current.value.tierKey === tierKey && current.value.sessionId === sessionId && current.value.modelId === modelId && current.value.region === region) return current
      } catch { /* No safe evidence; preserve uncertainty without replaying the write. */ }
      return failure('setSessionTier', 'persist-context-tier', error, { mutation: true, context: { ...scope, tierKey } })
    },
  }
}
