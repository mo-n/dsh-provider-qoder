import { applyQoderCatalogChange, cloneCatalogModel, resolveContextTier, type QoderCatalogChange, type QoderCatalogModel } from '../qoder/catalog.ts'
import type { QoderRegion } from '../qoder/region.ts'
import type { QoderCatalogEdit, QoderCatalogStatus, QoderRpcErrorDetail, QoderRpcResult } from '../dsh/rpc-channel.ts'
import type { QoderCredentialOperations } from './credential-operations.ts'

type CatalogOperations = Pick<QoderCredentialOperations, 'refreshCatalog' | 'editCatalog' | 'subscribeCatalog'>
type CatalogResult = QoderRpcResult<readonly QoderCatalogModel[]>
const editDebounceMs = 2000
const maxEditDelayMs = 5000
const editRetryDelays = [150, 300, 600, 1200, 2400] as const

function hasChanges(change: QoderCatalogChange): boolean {
  return change.enabled !== undefined || change.tierKey !== undefined || change.remove === true
}

function previewCatalogChange(model: QoderCatalogModel, change?: QoderCatalogChange): QoderCatalogModel | null {
  if (!change) return model
  const updated = applyQoderCatalogChange(model, change)
  if (updated !== undefined) return updated
  if (change.tierKey !== undefined && change.enabled !== undefined) return { ...model, enabled: change.enabled }
  return model
}

function unavailableTierIds(error?: QoderRpcErrorDetail): ReadonlySet<string> {
  if (error?.code !== 'CATALOG_TIER_UNAVAILABLE' || !error.details || !('modelIds' in error.details)) return new Set()
  const ids = error.details.modelIds
  return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [])
}

export interface QoderModelCatalogEditSnapshot {
  models: readonly QoderCatalogModel[]
  status?: QoderCatalogStatus
  pending?: 'discovering'
  viewModels: readonly QoderCatalogModel[]
  savingChanges: boolean
  hasPendingChanges: boolean
  refreshRequested: boolean
  failure?: 'modelsFetchFailed' | 'modelsUpdateNotSaved' | 'saveFailed' | 'catalogTierNotSaved'
}

export class QoderModelCatalogEditor {
  private readonly region: QoderRegion
  private readonly operations: CatalogOperations
  private readonly queued = new Map<string, QoderCatalogChange>()
  private readonly listeners = new Set<() => void>()
  private active = true
  private mounts = 0
  private unsubscribeStatus?: () => void
  private inFlight?: ReadonlyMap<string, QoderCatalogChange>
  private debounceTimer?: ReturnType<typeof setTimeout>
  private deadlineTimer?: ReturnType<typeof setTimeout>
  private batchReady = false
  private draining = false
  private retry?: ReturnType<typeof setTimeout>
  private editRetries = 0
  private snapshot: QoderModelCatalogEditSnapshot

  constructor(region: QoderRegion, models: readonly QoderCatalogModel[], operations: CatalogOperations) {
    this.region = region
    this.operations = operations
    const saved = models.map(cloneCatalogModel)
    this.snapshot = { models: saved, viewModels: saved, savingChanges: false, hasPendingChanges: false, refreshRequested: false }
  }

  getSnapshot = (): QoderModelCatalogEditSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  replaceModels(models: readonly QoderCatalogModel[]): void {
    if (this.active) this.publish({ models: models.map(cloneCatalogModel) })
  }

  activate(): void {
    this.mounts++
    this.active = true
    this.unsubscribeStatus ??= this.operations.subscribeCatalog?.(this.region, status => {
      this.publish({ status })
      void this.drain()
    })
  }

  dispose(): void {
    if (this.mounts > 0 && --this.mounts > 0) return
    this.active = false
    void this.flush()
    this.releaseSubscription()
  }

  private releaseSubscription(): void {
    if (this.active || this.draining || this.queued.size || this.snapshot.pending || this.snapshot.refreshRequested) return
    this.unsubscribeStatus?.()
    this.unsubscribeStatus = undefined
  }

  private publish(patch: Partial<QoderModelCatalogEditSnapshot>): void {
    const models = patch.models ?? this.snapshot.models
    const hasPendingChanges = !!this.inFlight || this.queued.size > 0
    const viewModels = hasPendingChanges ? models.flatMap(model => {
      const baseline = previewCatalogChange(model, this.inFlight?.get(model.id))
      if (baseline === null) return []
      const updated = previewCatalogChange(baseline, this.queued.get(model.id))
      return updated === null ? [] : [updated]
    }) : models
    this.snapshot = { ...this.snapshot, ...patch, viewModels, hasPendingChanges, savingChanges: !!this.inFlight }
    if (this.active) for (const listener of this.listeners) listener()
  }

  private hostLocked(): boolean {
    return this.snapshot.status?.refreshing === true || (!!this.operations.subscribeCatalog && !this.snapshot.status)
  }

  discover(): Promise<void> | undefined {
    if (!this.active || !this.operations.refreshCatalog || this.hostLocked()
      || this.snapshot.pending || this.snapshot.refreshRequested) return
    this.publish({ refreshRequested: true, failure: undefined })
    return this.flush()
  }

  edit(edit: Exclude<QoderCatalogEdit, { action: 'editBatch' }>): Promise<void> | undefined {
    if (!this.active || !this.operations.editCatalog || this.hostLocked() || this.snapshot.pending || this.snapshot.refreshRequested) return
    const model = this.snapshot.models.find(candidate => candidate.id === edit.id)
    const current = this.snapshot.viewModels.find(candidate => candidate.id === edit.id)
    if (!model || !current) return
    const sent = this.inFlight?.get(edit.id)
    const baseline = sent ? applyQoderCatalogChange(model, sent) ?? model : model
    const change = { id: edit.id, ...this.queued.get(edit.id) }

    if (edit.action === 'toggle') {
      if (sent?.enabled === undefined && edit.enabled === (baseline.enabled !== false)) delete change.enabled
      else change.enabled = edit.enabled
    } else if (edit.action === 'selectTier') {
      if (current.enabled === false || !applyQoderCatalogChange(current, { id: edit.id, tierKey: edit.tierKey })) return
      if (sent?.tierKey === undefined && edit.tierKey === resolveContextTier(baseline)?.key) delete change.tierKey
      else change.tierKey = edit.tierKey
    } else {
      if (!current.missingFromCatalog || current.enabled !== false) return
      change.remove = true
      if (model.enabled !== false) change.enabled = false
      delete change.tierKey
    }

    if (!hasChanges(change)) this.queued.delete(edit.id)
    else this.queued.set(edit.id, change)
    this.publish({ failure: undefined })
    if (!this.queued.size || this.batchReady) return this.flush()
    clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => { void this.flush() }, editDebounceMs)
    this.deadlineTimer ??= setTimeout(() => { void this.flush() }, maxEditDelayMs)
  }

  private flush(): Promise<void> {
    clearTimeout(this.debounceTimer)
    clearTimeout(this.deadlineTimer)
    this.debounceTimer = undefined
    this.deadlineTimer = undefined
    this.batchReady = this.queued.size > 0
    return this.drain()
  }

  private async drain(): Promise<void> {
    if (this.draining || this.retry !== undefined || this.hostLocked()) return
    this.draining = true
    try {
      const apply = this.operations.editCatalog
      while (apply && !this.hostLocked() && this.batchReady) {
        const modelsAtStart = this.snapshot.models
        const { batch, failure } = this.prepareBatch(modelsAtStart)
        this.queued.clear()
        this.batchReady = false
        const notice = failure ? { refreshRequested: false, failure } : {}
        if (!batch.size) {
          this.publish(notice)
          continue
        }
        this.inFlight = batch
        this.publish(notice)
        const result = await apply(this.region, { action: 'editBatch', changes: [...batch.values()] }).catch(() => undefined)
        this.inFlight = undefined
        if (result?.ok) {
          this.editRetries = 0
          this.confirm(result.value, modelsAtStart)
          continue
        }

        const code = result?.error.code
        if (this.retryWhenAvailable(code)) {
          this.restoreBatch(batch)
          this.publish({})
          void this.flush()
          return
        }

        const staleTiers = unavailableTierIds(result?.error)
        if ([...batch.values()].some(change => change.tierKey !== undefined && staleTiers.has(change.id))) {
          this.restoreBatch(batch, staleTiers)
          this.publish({ refreshRequested: false, failure: 'catalogTierNotSaved' })
          void this.flush()
          continue
        }
        this.publish({ refreshRequested: false, failure: 'saveFailed' })
      }

      const refresh = this.operations.refreshCatalog
      if (refresh && this.snapshot.refreshRequested && !this.queued.size && !this.hostLocked()) {
        const modelsAtStart = this.snapshot.models
        this.publish({ pending: 'discovering', refreshRequested: false })
        const result = await refresh(this.region).catch(() => undefined)
        if (result?.ok) {
          this.editRetries = 0
          this.confirm(result.value, modelsAtStart, { pending: undefined })
        } else if (this.retryWhenAvailable(result?.error.code)) {
          this.publish({ pending: undefined, refreshRequested: true })
        } else {
          const failure = result?.error.code === 'CATALOG_SAVE_FAILED' ? 'modelsUpdateNotSaved' : 'modelsFetchFailed'
          this.publish({ pending: undefined, failure })
        }
      }
    } finally {
      this.draining = false
      this.releaseSubscription()
    }
  }

  private prepareBatch(models: readonly QoderCatalogModel[]) {
    const saved = new Map(models.map(model => [model.id, model]))
    const batch = new Map<string, QoderCatalogChange>()
    let invalid = false
    let staleTier = false
    for (const [id, change] of this.queued) {
      const model = saved.get(id)
      if (!model) {
        invalid = true
        continue
      }
      const next = { ...change }
      if (next.enabled === (model.enabled !== false)) delete next.enabled
      if (next.tierKey !== undefined) {
        if (!applyQoderCatalogChange(model, { id, tierKey: next.tierKey })) {
          delete next.tierKey
          staleTier = true
        } else if (next.tierKey === resolveContextTier(model)?.key) {
          delete next.tierKey
        }
      }
      if (!hasChanges(next)) continue
      if (applyQoderCatalogChange(model, next) === undefined) invalid = true
      else batch.set(id, next)
    }
    const failure = invalid ? 'saveFailed' : staleTier ? 'catalogTierNotSaved' : undefined
    return { batch, failure } as const
  }

  private restoreBatch(batch: ReadonlyMap<string, QoderCatalogChange>, staleTiers?: ReadonlySet<string>): void {
    for (const [id, change] of batch) {
      const sent = { ...change }
      if (staleTiers?.has(id)) delete sent.tierKey
      const combined = { ...sent, ...this.queued.get(id) }
      if (combined.remove) delete combined.tierKey
      if (hasChanges(combined)) this.queued.set(id, combined)
    }
  }

  private retryWhenAvailable(code?: QoderRpcErrorDetail['code']): boolean {
    if (code !== 'CATALOG_EDITING') this.editRetries = 0
    if (code !== 'CATALOG_EDITING' && code !== 'CATALOG_REFRESHING') return false
    if (this.hostLocked()) return true
    const delay = code === 'CATALOG_EDITING' ? editRetryDelays[this.editRetries++] : 150
    if (delay === undefined) {
      this.editRetries = 0
      return false
    }
    this.retry = setTimeout(() => {
      this.retry = undefined
      void this.drain()
    }, delay)
    return true
  }

  private confirm(
    saved: readonly QoderCatalogModel[],
    modelsAtStart: readonly QoderCatalogModel[],
    patch: Partial<QoderModelCatalogEditSnapshot> = {},
  ): void {
    // A newer settings notification is authoritative over this acknowledgement.
    const models = this.snapshot.models === modelsAtStart ? saved.map(cloneCatalogModel) : this.snapshot.models
    this.publish({ ...patch, models })
  }
}
