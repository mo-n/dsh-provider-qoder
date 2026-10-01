/** Region-scoped Qoder model discovery, effective catalogs, and advisory persistence. */
import { SettingsConflictError } from '@deepseek-ai/dsh-settings'
import { cloneCatalogModel, hasSameQoderDiscoveryMetadata, mergeQoderDiscoveryMetadata, type QoderCatalogModel } from '../qoder/catalog.ts'
import type { QoderRegion } from '../qoder/region.ts'
import type { QoderTransport } from '../qoder/transport/index.ts'
import { QoderLlmError } from '../qoder/errors.ts'
import { Config, modelsFor } from './config.ts'

export interface QoderCatalogSettings {
  read(region: QoderRegion): { models: readonly QoderCatalogModel[]; revision: number } | undefined
  write(region: QoderRegion, models: readonly QoderCatalogModel[], revision: number): Promise<void>
}

interface CatalogState {
  models: readonly QoderCatalogModel[]
  generation: number
  expiresAt: number
  inflight?: Promise<readonly QoderCatalogModel[]>
  dirty: boolean
  retryRequested: boolean
  writing?: Promise<void>
}

interface QoderCatalogLifecycleOptions {
  resolveTransport(): QoderTransport
  region(): QoderRegion
  configuredModels(region: QoderRegion): readonly QoderCatalogModel[]
  onDiscovered?(transport: QoderTransport, models: readonly QoderCatalogModel[]): unknown
  onPersistenceError?(error: unknown): void
}

export class QoderCatalogLifecycle {
  private readonly options: QoderCatalogLifecycleOptions
  private readonly catalogs: Record<QoderRegion, CatalogState> = {
    global: { models: [], generation: 0, expiresAt: 0, dirty: false, retryRequested: false },
    china: { models: [], generation: 0, expiresAt: 0, dirty: false, retryRequested: false },
  }
  private settings?: QoderCatalogSettings
  private disposed = false
  private activeTransport?: QoderTransport
  private activeRegion?: QoderRegion

  constructor(options: QoderCatalogLifecycleOptions) {
    this.options = options
  }

  /** Observe every transport replacement, including switching away and back. */
  observeTransport(): void {
    const transport = this.options.resolveTransport()
    const region = this.options.region()
    if (transport === this.activeTransport && region === this.activeRegion) return
    if (this.activeRegion !== undefined) {
      const previous = this.catalogs[this.activeRegion]
      previous.generation++
      previous.inflight = undefined
    }
    this.activeTransport = transport
    this.activeRegion = region
    const state = this.catalogs[region]
    state.generation++
    state.expiresAt = 0
    state.inflight = undefined
  }

  models(): readonly QoderCatalogModel[] {
    this.observeTransport()
    const region = this.options.region()
    return mergeQoderDiscoveryMetadata(this.options.configuredModels(region), this.catalogs[region].models)
  }

  /** Automatic reads join the newest discovery and never wait for settings writes. */
  async refresh(): Promise<void> {
    while (!this.disposed) {
      this.observeTransport()
      const region = this.options.region()
      const state = this.catalogs[region]
      const transport = this.activeTransport!
      const pending = state.inflight ?? (Date.now() >= state.expiresAt ? this.discover() : undefined)
      await pending?.catch(() => {})
      this.observeTransport()
      if (this.activeTransport !== transport || this.activeRegion !== region) continue
      if (state.inflight && state.inflight !== pending) continue
      return
    }
  }

  /** Explicit discovery supersedes older work as soon as it starts, even if it fails. */
  discover(signal?: AbortSignal, requestTransport?: QoderTransport): Promise<readonly QoderCatalogModel[]> {
    if (this.disposed || signal?.aborted) {
      return Promise.reject(new QoderLlmError('Qoder model discovery was aborted.', 'ABORTED'))
    }
    this.observeTransport()
    const region = this.options.region()
    const state = this.catalogs[region]
    const transport = this.activeTransport!
    const generation = ++state.generation
    const pending = Promise.resolve().then(() => (requestTransport ?? transport).discoverModels(signal)).then(models => {
      this.observeTransport()
      if (!this.disposed && this.activeTransport === transport && this.activeRegion === region && state.generation === generation) {
        state.models = models.map(cloneCatalogModel)
        state.expiresAt = Date.now() + 5 * 60 * 1000
        state.dirty = true
        this.schedulePersistence(region)
        try {
          void Promise.resolve(this.options.onDiscovered?.(transport, state.models)).catch(() => {})
        } catch {
          // Notification is advisory, just like metadata persistence.
        }
      }
      return models
    }).finally(() => {
      if (state.inflight === pending) state.inflight = undefined
    })
    state.inflight = pending
    return pending
  }

  bindSettings(settings: QoderCatalogSettings | undefined): void {
    this.settings = settings
    this.retryPersistence()
  }

  /** Called by settings changes/reattachment; no timer retries or fallback writes. */
  retryPersistence(): void {
    for (const region of ['global', 'china'] as const) {
      const state = this.catalogs[region]
      if (state.models.length === 0) continue
      state.dirty = true
      this.schedulePersistence(region)
    }
  }

  dispose(): void {
    this.disposed = true
    this.settings = undefined
    for (const state of Object.values(this.catalogs)) state.generation++
  }

  private schedulePersistence(region: QoderRegion): void {
    const state = this.catalogs[region]
    const settings = this.settings
    if (this.disposed || !settings || !state.dirty) return
    if (state.writing) {
      state.retryRequested = true
      return
    }
    state.retryRequested = false
    const writing = Promise.resolve().then(() => this.persist(region, settings)).catch(error => {
      this.options.onPersistenceError?.(error)
    }).finally(() => {
      if (state.writing === writing) state.writing = undefined
      // A replacement binding waits for the previous writer to finish.
      if (this.settings !== settings || state.retryRequested) this.schedulePersistence(region)
    })
    state.writing = writing
  }

  private async persist(region: QoderRegion, settings: QoderCatalogSettings): Promise<void> {
    const state = this.catalogs[region]
    while (!this.disposed && this.settings === settings && state.dirty) {
      const snapshot = settings.read(region)
      if (!snapshot) return // Keep dirty until settings becomes available/writable.
      const enriched = modelsFor(Config({
        modelsByRegion: { [region]: mergeQoderDiscoveryMetadata(snapshot.models, state.models) },
      }), region)
      state.dirty = false
      if (hasSameQoderDiscoveryMetadata(snapshot.models, enriched)) continue
      try {
        await settings.write(region, enriched, snapshot.revision)
      } catch (error) {
        state.dirty = true
        if (!(error instanceof SettingsConflictError)) throw error
        // Re-read the latest selection, revision and accepted metadata together.
      }
    }
  }
}
