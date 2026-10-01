import { cloneCatalogModel, type QoderCatalogModel } from '../qoder/catalog.ts'
import type { QoderRegion } from '../qoder/region.ts'
import { reconcileQoderModels, type QoderCredentialOperations } from './credential-operations.ts'

export interface QoderModelCatalogEditSnapshot {
  models: readonly QoderCatalogModel[]
  catalog: readonly QoderCatalogModel[]
  unavailableIds: ReadonlySet<string>
  pending?: 'discovering' | 'saving'
  failure?: 'modelsRequired' | 'modelsFetchFailed' | 'saveFailed'
  failureMessage?: string
}

/** One mounted region owns its directory and asynchronous edits. */
export class QoderModelCatalogEditor {
  private readonly region: QoderRegion
  private readonly operations: Pick<QoderCredentialOperations, 'discoverModels' | 'storeModels'>
  private active = true
  private confirmed: readonly QoderCatalogModel[]
  private snapshot: QoderModelCatalogEditSnapshot
  private readonly listeners = new Set<() => void>()

  constructor(
    region: QoderRegion,
    models: readonly QoderCatalogModel[],
    operations: Pick<QoderCredentialOperations, 'discoverModels' | 'storeModels'>,
  ) {
    this.region = region
    this.operations = operations
    this.confirmed = models.map(cloneCatalogModel)
    this.snapshot = { models: this.confirmed, catalog: this.confirmed, unavailableIds: new Set() }
  }

  getSnapshot = (): QoderModelCatalogEditSnapshot => this.snapshot
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** ConfigForms supplies accepted values, including its recovery read after refusal. */
  replaceModels(models: readonly QoderCatalogModel[]): void {
    const followsConfig = this.snapshot.catalog === this.confirmed
    this.confirmed = models.map(cloneCatalogModel)
    const selected = new Map(this.confirmed.map(model => [model.id, model]))
    this.publish({ ...this.snapshot, models: this.confirmed,
      catalog: followsConfig ? this.confirmed : this.snapshot.catalog.map(model => selected.get(model.id) ?? model) })
  }

  activate(): void {
    this.active = true
  }

  dispose(): void {
    this.active = false
    this.listeners.clear()
  }

  private publish(snapshot: QoderModelCatalogEditSnapshot): void {
    if (!this.active) return
    this.snapshot = snapshot
    for (const listener of this.listeners) listener()
  }

  async discover(): Promise<void> {
    if (!this.active || this.snapshot.pending) return
    this.publish({ ...this.snapshot, pending: 'discovering', failure: undefined, failureMessage: undefined })
    try {
      const result = await this.operations.discoverModels()
      // Switching region disposes this editor. Old discovery must never submit a save.
      if (!this.active) return
      if (!result.ok) {
        this.publish({ ...this.snapshot, pending: undefined, failure: 'modelsFetchFailed', failureMessage: result.error.message })
        return
      }
      const reconciled = reconcileQoderModels(this.snapshot.catalog, result.value)
      await this.save(reconciled.selected, reconciled.catalog, reconciled.unavailableIds)
    } catch (error) {
      this.publish({ ...this.snapshot, pending: undefined, failure: 'modelsFetchFailed',
        failureMessage: error instanceof Error ? error.message : undefined })
    }
  }

  async toggle(id: string, enabled: boolean): Promise<void> {
    if (!this.active || this.snapshot.pending || this.snapshot.unavailableIds.has(id)) return
    const selected = new Set(this.snapshot.models.map(model => model.id))
    if (enabled) selected.add(id)
    else selected.delete(id)
    await this.save(this.snapshot.catalog.filter(model => selected.has(model.id) && !this.snapshot.unavailableIds.has(model.id)))
  }

  async selectTier(id: string, tierKey: string): Promise<void> {
    if (!this.active || this.snapshot.pending || !this.snapshot.models.some(model => model.id === id)) return
    const model = this.snapshot.catalog.find(model => model.id === id)
    const tokenCount = model?.contextOptions?.[tierKey]?.tokenCount
    if (typeof tokenCount !== 'number' || !Number.isFinite(tokenCount) || tokenCount <= 0) return
    const apply = (candidate: QoderCatalogModel): QoderCatalogModel => candidate.id === id
      ? { ...candidate, contextTier: tierKey, contextWindow: tokenCount } : candidate
    await this.save(this.snapshot.models.map(apply), this.snapshot.catalog.map(apply))
  }

  private async save(
    models: readonly QoderCatalogModel[],
    catalog = this.snapshot.catalog,
    unavailableIds = this.snapshot.unavailableIds,
  ): Promise<void> {
    if (models.length === 0) {
      this.publish({ ...this.snapshot, pending: undefined, failure: 'modelsRequired', failureMessage: undefined })
      return
    }
    const submitted = models.map(cloneCatalogModel)
    this.publish({ ...this.snapshot, pending: 'saving', failure: undefined, failureMessage: undefined })
    let saved = false
    try {
      // Region is immutable: even a disposed editor finishes an already submitted save here.
      saved = await this.operations.storeModels(this.region, submitted)
    } catch {
      // Restore the accepted configuration just as for a refused write.
    }
    if (!this.active) return
    if (saved) {
      this.confirmed = submitted
      this.publish({ models: submitted, catalog, unavailableIds })
    } else {
      this.publish({ models: this.confirmed, catalog: this.confirmed, unavailableIds: new Set(), failure: 'saveFailed' })
    }
  }
}
