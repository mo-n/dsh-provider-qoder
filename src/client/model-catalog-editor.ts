import { cloneCatalogModel, type QoderCatalogModel } from '../qoder/catalog.ts'
import type { QoderRegion } from '../qoder/region.ts'
import type { QoderCatalogEdit, QoderCatalogStatus, QoderRpcResult } from '../dsh/rpc-channel.ts'
import type { QoderCredentialOperations } from './credential-operations.ts'

type CatalogOperations = Pick<QoderCredentialOperations, 'refreshCatalog' | 'editCatalog' | 'subscribeCatalog'>
type CatalogResult = QoderRpcResult<readonly QoderCatalogModel[]>
const toggleDebounceMs = 2000
const maxToggleDelayMs = 5000

export interface QoderModelCatalogEditSnapshot {
  models: readonly QoderCatalogModel[]
  status?: QoderCatalogStatus
  pending?: 'discovering' | 'saving'
  savingToggles: boolean
  pendingToggles: ReadonlyMap<string, boolean>
  refreshRequested: boolean
  failure?: 'modelsFetchFailed' | 'modelsUpdateNotSaved' | 'saveFailed'
}

export class QoderModelCatalogEditor {
  private readonly region: QoderRegion
  private readonly operations: CatalogOperations
  private readonly queued = new Map<string, boolean>()
  private readonly listeners = new Set<() => void>()
  private active = true
  private mounts = 0
  private unsubscribeStatus?: () => void
  private inFlight?: ReadonlyMap<string, boolean>
  private debounceTimer?: ReturnType<typeof setTimeout>
  private deadlineTimer?: ReturnType<typeof setTimeout>
  private batchReady = false
  private draining = false
  private retry?: ReturnType<typeof setTimeout>
  private snapshot: QoderModelCatalogEditSnapshot

  constructor(region: QoderRegion, models: readonly QoderCatalogModel[], operations: CatalogOperations) {
    this.region = region
    this.operations = operations
    this.snapshot = { models: models.map(cloneCatalogModel), pendingToggles: new Map(), savingToggles: false, refreshRequested: false }
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
    const pendingToggles = new Map(this.inFlight)
    for (const [id, enabled] of this.queued) pendingToggles.set(id, enabled)
    this.snapshot = { ...this.snapshot, ...patch, pendingToggles, savingToggles: this.inFlight !== undefined }
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

  edit(edit: Exclude<QoderCatalogEdit, { action: 'toggleBatch' }>): Promise<void> | undefined {
    const apply = this.operations.editCatalog
    if (!this.active || !apply || this.hostLocked() || this.snapshot.pending || this.snapshot.refreshRequested) return
    if (edit.action === 'toggle') {
      const model = this.snapshot.models.find(candidate => candidate.id === edit.id)
      if (!model) return
      const saved = this.inFlight?.get(edit.id) ?? (model.enabled !== false)
      if (edit.enabled === saved) this.queued.delete(edit.id)
      else this.queued.set(edit.id, edit.enabled)
      this.publish({ failure: undefined })
      if (!this.queued.size || this.batchReady) return this.flush()
      clearTimeout(this.debounceTimer)
      this.debounceTimer = setTimeout(() => { void this.flush() }, toggleDebounceMs)
      this.deadlineTimer ??= setTimeout(() => { void this.flush() }, maxToggleDelayMs)
      return
    }
    if (this.draining || this.queued.size) return
    return this.saveEdit(edit, apply)
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
        const knownIds = new Set(modelsAtStart.map(model => model.id))
        const batch = new Map([...this.queued].filter(([id]) => knownIds.has(id)))
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
        const toggles = Array.from(batch, ([id, enabled]) => ({ id, enabled }))
        const result = await apply(this.region, { action: 'toggleBatch', toggles }).catch(() => undefined)
        this.inFlight = undefined
        if (result?.ok) {
          this.confirm(result.value, modelsAtStart)
        } else if (result?.error.code === 'CATALOG_REFRESHING') {
          // A refresh may start before its status reaches this page.
          for (const [id, enabled] of batch) {
            if (!this.queued.has(id)) this.queued.set(id, enabled)
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

  private async saveEdit(edit: QoderCatalogEdit, apply: NonNullable<CatalogOperations['editCatalog']>): Promise<void> {
    const modelsAtStart = this.snapshot.models
    this.publish({ pending: 'saving', failure: undefined })
    const result = await apply(this.region, edit).catch(() => undefined)
    const settled = { pending: undefined }
    if (result?.ok) this.confirm(result.value, modelsAtStart, settled)
    else this.publish({ ...settled, failure: 'saveFailed' })
    this.releaseSubscription()
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
