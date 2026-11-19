import { applyQoderCatalogChange, cloneCatalogModel, resolveContextTier, type QoderCatalogChange, type QoderCatalogModel } from '../qoder/catalog.ts'
import type { QoderRegion } from '../qoder/region.ts'
import type { QoderCatalogEdit, QoderCatalogStatus, QoderRpcResult } from '../dsh/rpc-channel.ts'
import type { QoderCredentialOperations } from './credential-operations.ts'

type CatalogOperations = Pick<QoderCredentialOperations, 'refreshCatalog' | 'editCatalog' | 'subscribeCatalog'>
type CatalogResult = QoderRpcResult<readonly QoderCatalogModel[]>
const editDebounceMs = 2000
const maxEditDelayMs = 5000

export interface QoderModelCatalogEditSnapshot {
  models: readonly QoderCatalogModel[]
  status?: QoderCatalogStatus
  pending?: 'discovering'
  viewModels: readonly QoderCatalogModel[]
  savingChanges: boolean
  hasPendingChanges: boolean
  refreshRequested: boolean
  failure?: 'modelsFetchFailed' | 'modelsUpdateNotSaved' | 'saveFailed'
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
      const sent = this.inFlight?.get(model.id)
      const queued = this.queued.get(model.id)
      const baseline = sent ? applyQoderCatalogChange(model, sent) : model
      if (baseline === null) return []
      const current = baseline ?? model
      const updated = queued ? applyQoderCatalogChange(current, queued) : current
      return updated === null ? [] : [updated ?? current]
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
      if (edit.enabled === (baseline.enabled !== false)) delete change.enabled
      else change.enabled = edit.enabled
    } else if (edit.action === 'selectTier') {
      if (current.enabled === false || !applyQoderCatalogChange(current, { id: edit.id, tierKey: edit.tierKey })) return
      if (edit.tierKey === resolveContextTier(baseline)?.key) delete change.tierKey
      else change.tierKey = edit.tierKey
    } else {
      if (!current.missingFromCatalog || current.enabled !== false) return
      change.remove = true
      if (model.enabled !== false) change.enabled = false
      delete change.tierKey
    }

    if (change.enabled === undefined && change.tierKey === undefined && !change.remove) this.queued.delete(edit.id)
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
        const saved = new Map(modelsAtStart.map(model => [model.id, model]))
        const batch = new Map([...this.queued].filter(([id, change]) => {
          const model = saved.get(id)
          return model && applyQoderCatalogChange(model, change) !== undefined
        }))
        const missing = batch.size !== this.queued.size
        this.queued.clear()
        this.batchReady = false
        const failure = missing ? { refreshRequested: false, failure: 'saveFailed' as const } : {}
        if (!batch.size) {
          this.publish(failure)
          continue
        }
        this.inFlight = batch
        this.publish(failure)
        const result = await apply(this.region, { action: 'editBatch', changes: [...batch.values()] }).catch(() => undefined)
        this.inFlight = undefined
        if (result?.ok) {
          this.confirm(result.value, modelsAtStart)
        } else if (result?.error.code === 'CATALOG_REFRESHING') {
          // A refresh may start before its status reaches this page.
          for (const [id, change] of batch) {
            const newer = this.queued.get(id)
            const combined = { ...change, ...newer }
            if (combined.remove) delete combined.tierKey
            this.queued.set(id, combined)
          }
          this.publish({})
          void this.flush()
          this.retryAfterRefresh()
          return
        } else {
          this.publish({ refreshRequested: false, failure: 'saveFailed' })
        }
      }

      const refresh = this.operations.refreshCatalog
      if (refresh && this.snapshot.refreshRequested && !this.queued.size && !this.hostLocked()) {
        const modelsAtStart = this.snapshot.models
        this.publish({ pending: 'discovering', refreshRequested: false })
        const result = await refresh(this.region).catch(() => undefined)
        if (result?.ok) this.confirm(result.value, modelsAtStart, { pending: undefined })
        else if (result?.error.code === 'CATALOG_REFRESHING') {
          this.publish({ pending: undefined, refreshRequested: true })
          this.retryAfterRefresh()
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

  private retryAfterRefresh(): void {
    if (this.hostLocked()) return
    this.retry = setTimeout(() => {
      this.retry = undefined
      void this.drain()
    }, 150)
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
