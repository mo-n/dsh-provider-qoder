/** Region-scoped Qoder model discovery and catalog updates. */
import { isDeepStrictEqual } from 'node:util'
import { SettingsConflictError } from '@deepseek-ai/dsh-settings'
import { applyQoderCatalogChange, cloneCatalogModel, hasSameQoderDiscoveryMetadata, mergeQoderDiscoveryMetadata, reconcileQoderCatalog, type QoderCatalogModel } from '../qoder/catalog.ts'
import type { QoderRegion } from '../qoder/region.ts'
import type { QoderTransport } from '../qoder/transport/index.ts'
import { QoderLlmError } from '../qoder/errors.ts'
import { Config, modelsFor } from './config.ts'
import { QoderRequestError } from './request-error.ts'
import type { QoderCatalogEdit, QoderCatalogStatus } from './rpc-channel.ts'

export interface QoderCatalogSettings {
  read(region: QoderRegion): { models: readonly QoderCatalogModel[]; revision: number } | undefined
  write(region: QoderRegion, models: readonly QoderCatalogModel[], revision: number): Promise<void>
}

interface CatalogWrite {
  before: readonly QoderCatalogModel[]
  after: readonly QoderCatalogModel[]
}

interface CatalogRefresh {
  controller: AbortController
  manual: boolean
  persisting: boolean
  keepAlive: boolean
  waiters: number
  write?: CatalogWrite
  discovery: Promise<readonly QoderCatalogModel[]>
  completion: Promise<readonly QoderCatalogModel[]>
}

interface CatalogState {
  models: readonly QoderCatalogModel[]
  expiresAt: number
  running?: CatalogRefresh
  editing?: Promise<readonly QoderCatalogModel[]>
  failure?: QoderCatalogStatus['failure']
  needsPersistence?: boolean
}

export interface QoderCatalogLifecycleOptions {
  resolveTransport(): QoderTransport
  region(): QoderRegion
  configuredModels(region: QoderRegion): readonly QoderCatalogModel[]
  onDiscovered?(transport: QoderTransport, models: readonly QoderCatalogModel[]): unknown
  onPersistenceError?(error: unknown): void
  persistenceConflictBackoffMs?: readonly number[]
}

const defaultPersistenceConflictBackoffMs = [50, 100, 200] as const
/** Revert the changes from a stale write while preserving later changes to the same records. */
function revertCatalogWrite(current: readonly QoderCatalogModel[], { before, after }: CatalogWrite): QoderCatalogModel[] {
  const previous = new Map(before.map(model => [model.id, model]))
  const written = new Map(after.map(model => [model.id, model]))
  return current.flatMap(model => {
    const stale = written.get(model.id)
    if (!stale) return [model]
    const original = previous.get(model.id)
    if (!original) return isDeepStrictEqual(model, stale) ? [] : [model]
    const result: QoderCatalogModel = { ...model }
    for (const key of Object.keys({ ...original, ...stale }) as (keyof QoderCatalogModel)[]) {
      if (isDeepStrictEqual(original[key], stale[key]) || !isDeepStrictEqual(model[key], stale[key])) continue
      if (Object.hasOwn(original, key)) Object.assign(result, { [key]: original[key] })
      else delete result[key]
    }
    return [result]
  })
}

const aborted = () => new QoderLlmError('Qoder model discovery was aborted.', 'ABORTED')

function waitForDiscovery<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(aborted())
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    void pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

export class QoderCatalogLifecycle {
  private readonly catalogs: Record<QoderRegion, CatalogState> = {
    global: { models: [], expiresAt: 0 },
    china: { models: [], expiresAt: 0 },
  }
  private readonly listeners = new Set<(status: QoderCatalogStatus) => void>()
  private settings?: QoderCatalogSettings
  private disposed = false
  private activeTransport?: QoderTransport
  private activeRegion?: QoderRegion

  private readonly options: QoderCatalogLifecycleOptions

  constructor(options: QoderCatalogLifecycleOptions) {
    this.options = options
  }

  status(region: QoderRegion): QoderCatalogStatus {
    const state = this.catalogs[region]
    return { region, refreshing: state.running !== undefined, failure: state.failure }
  }

  subscribe(listener: (status: QoderCatalogStatus) => void): () => void {
    this.listeners.add(listener)
    listener(this.status('global'))
    listener(this.status('china'))
    return () => { this.listeners.delete(listener) }
  }

  private publish(region: QoderRegion): void {
    const status = this.status(region)
    for (const listener of this.listeners) {
      try { listener(status) } catch { /* Keep other settings pages informed. */ }
    }
  }

  private invalidate(region: QoderRegion): void {
    const state = this.catalogs[region]
    state.running?.controller.abort()
    if (!state.running?.persisting) state.running = undefined
    state.expiresAt = 0
    state.failure = undefined
    state.needsPersistence = false
    this.publish(region)
  }

  /** Observe transport changes, including switching away and back. */
  observeTransport(): void {
    const transport = this.options.resolveTransport()
    const region = this.options.region()
    if (transport === this.activeTransport && region === this.activeRegion) return
    const previous = this.activeRegion
    this.activeTransport = transport
    this.activeRegion = region
    if (previous !== undefined && previous !== region) this.invalidate(previous)
    this.invalidate(region)
  }

  models(): readonly QoderCatalogModel[] {
    this.observeTransport()
    const region = this.options.region()
    const state = this.catalogs[region]
    const configured = this.options.configuredModels(region)
    const running = state.running
    const models = running?.controller.signal.aborted && running.write
      ? revertCatalogWrite(configured, running.write)
      : configured
    return mergeQoderDiscoveryMetadata(models, state.models)
  }

  clearDiscovered(): void {
    for (const region of ['global', 'china'] as const) {
      this.catalogs[region].models = []
      this.invalidate(region)
    }
  }

  /** Reads can use the accepted catalog while an expired discovery is revalidated. */
  async refresh(): Promise<void> {
    while (!this.disposed) {
      this.observeTransport()
      const region = this.activeRegion!
      const state = this.catalogs[region]
      const transport = this.activeTransport
      if (state.running?.controller.signal.aborted) {
        const settling = state.running.completion.catch(() => {})
        if (state.models.length > 0) {
          void settling.then(() => {
            this.observeTransport()
            if (transport === this.activeTransport && region === this.activeRegion) return this.refresh()
          }).catch(() => {})
          return
        }
        await settling
        continue
      }
      const running = state.running ?? (Date.now() >= state.expiresAt && !state.editing
        ? this.startRefresh(region, false)
        : undefined)
      if (running) running.keepAlive = true
      const pending = running?.completion ?? state.editing?.catch(() => {}).then(() => this.refresh())
      if (state.models.length > 0) {
        void pending?.catch(() => {})
        return
      }
      await pending?.catch(() => {})
      this.observeTransport()
      if (transport === this.activeTransport && region === this.activeRegion) return
    }
  }

  /** DSH discovery returns upstream entries. A foreign credential is an isolated preview. */
  discover(signal?: AbortSignal, requestTransport?: QoderTransport): Promise<readonly QoderCatalogModel[]> {
    if (this.disposed || signal?.aborted) return Promise.reject(aborted())
    this.observeTransport()
    if (requestTransport && requestTransport !== this.activeTransport) return requestTransport.discoverModels(signal)
    const region = this.activeRegion!
    const state = this.catalogs[region]
    if (state.editing) {
      const transport = this.activeTransport
      return waitForDiscovery(state.editing.catch(() => {}), signal).then(() => {
        this.observeTransport()
        if (this.activeRegion !== region || this.activeTransport !== transport) throw aborted()
        return this.discover(signal, requestTransport)
      })
    }
    const running = state.running ?? this.startRefresh(region, false)
    return this.joinRefresh(running, running.discovery, signal)
  }

  refreshCatalog(region: QoderRegion, signal?: AbortSignal): Promise<readonly QoderCatalogModel[]> {
    this.observeTransport()
    if (this.disposed || signal?.aborted) return Promise.reject(aborted())
    if (region !== this.activeRegion) return Promise.reject(new QoderRequestError('The active Qoder service region is required.'))
    const state = this.catalogs[region]
    if (state.running && !state.running.manual) {
      return Promise.reject(new QoderLlmError('The Qoder model catalog is being updated.', 'CATALOG_REFRESHING'))
    }
    if (state.editing) return Promise.reject(new QoderRequestError('The Qoder model catalog is being updated.'))
    const running = state.running ?? this.startRefresh(region, true)
    return this.joinRefresh(running, running.completion, signal)
  }

  private joinRefresh<T>(running: CatalogRefresh, pending: Promise<T>, signal?: AbortSignal): Promise<T> {
    running.waiters++
    return waitForDiscovery(pending, signal).finally(() => {
      running.waiters--
      if (signal?.aborted && !running.waiters && !running.keepAlive && !running.persisting) {
        running.controller.abort()
      }
    })
  }

  private startRefresh(region: QoderRegion, manual: boolean, cached?: readonly QoderCatalogModel[]): CatalogRefresh {
    const state = this.catalogs[region]
    const transport = this.activeTransport!
    const controller = new AbortController()
    const knownAtStart = manual
      ? new Set((this.settings?.read(region)?.models ?? this.options.configuredModels(region)).map(model => model.id))
      : undefined
    const discovery = Promise.resolve().then(async () => {
      if (controller.signal.aborted) throw aborted()
      const models = cached ?? await transport.discoverModels(controller.signal)
      if (!models.length) throw new QoderLlmError('Qoder model discovery returned no enabled models.', 'EMPTY_RESPONSE')
      return models
    })
    const completion = discovery.then(async models => {
      this.observeTransport()
      if (controller.signal.aborted) throw aborted()
      running.persisting = true
      const saved = await this.persistRefresh(region, models, running, knownAtStart)
      this.observeTransport()
      if (controller.signal.aborted) {
        if (running.write && saved) await this.revertRefresh(region, running.write)
        throw aborted()
      }
      state.models = models.map(cloneCatalogModel)
      state.expiresAt = Date.now() + 5 * 60 * 1000
      state.needsPersistence = saved === undefined
      try {
        void Promise.resolve(this.options.onDiscovered?.(transport, state.models)).catch(() => {})
      } catch { /* Adapter notification is advisory. */ }
      return saved ?? this.options.configuredModels(region)
    }, error => {
      if (!controller.signal.aborted) state.failure = 'fetch'
      throw error
    }).finally(() => {
      if (state.running?.controller !== controller) return
      state.running = undefined
      this.publish(region)
      if (state.needsPersistence) this.retryPersistence()
    })
    void completion.catch(() => {})
    const running: CatalogRefresh = {
      controller, manual, persisting: false, keepAlive: cached !== undefined, waiters: 0, discovery, completion,
    }
    state.running = running
    state.failure = undefined
    this.publish(region)
    return running
  }

  private async persistRefresh(
    region: QoderRegion,
    models: readonly QoderCatalogModel[],
    running: CatalogRefresh,
    knownAtStart?: ReadonlySet<string>,
  ) {
    const state = this.catalogs[region]
    const signal = running.controller.signal
    try {
      return await this.writeCatalog(region, current => {
        const reconciled = reconcileQoderCatalog(current, models, running.manual)
        if (!knownAtStart) return reconciled
        const saved = new Set(current.map(model => model.id))
        return reconciled.filter(model => saved.has(model.id) || !knownAtStart.has(model.id))
      }, {
        signal,
        allowUnavailable: !running.manual,
        onWrite: write => { running.write = write },
      })
    } catch (error) {
      if (signal.aborted) throw aborted()
      state.needsPersistence = false
      state.failure = 'save'
      // Defer further automatic attempts until the next cache window.
      state.expiresAt = Date.now() + 5 * 60 * 1000
      this.options.onPersistenceError?.(error)
      throw new QoderLlmError('The Qoder model catalog update was not saved.', 'CATALOG_SAVE_FAILED')
    }
  }

  private async revertRefresh(region: QoderRegion, write: CatalogWrite): Promise<void> {
    try {
      await this.writeCatalog(region, current => revertCatalogWrite(current, write))
    } catch (error) {
      this.catalogs[region].failure = 'save'
      this.options.onPersistenceError?.(error)
      throw new QoderLlmError('The stale Qoder model catalog update could not be reverted.', 'CATALOG_SAVE_FAILED')
    }
  }

  async editCatalog(region: QoderRegion, edit: QoderCatalogEdit): Promise<readonly QoderCatalogModel[]> {
    this.observeTransport()
    const state = this.catalogs[region]
    if (state.running) throw new QoderLlmError('The Qoder model catalog is being updated.', 'CATALOG_REFRESHING')
    if (state.editing) throw new QoderRequestError('The Qoder model catalog is being updated.')
    const pending = this.writeCatalog(region, models => {
      if (edit.action === 'editBatch' || edit.action === 'toggle') {
        const changes = edit.action === 'editBatch' ? edit.changes : [edit]
        const desired = new Map(changes.map(change => [change.id, change]))
        const savedIds = new Set(models.map(model => model.id))
        if (changes.some(change => !savedIds.has(change.id))) {
          throw new QoderRequestError('The model is no longer saved in this region.')
        }
        return models.flatMap(model => {
          const change = desired.get(model.id)
          if (!change) return [model]
          const updated = applyQoderCatalogChange(model, change)
          if (updated === undefined) throw new QoderRequestError('A catalog edit is no longer valid.')
          return updated === null ? [] : [updated]
        })
      }
      const model = models.find(candidate => candidate.id === edit.id)
      if (!model) throw new QoderRequestError('The model is no longer saved in this region.')
      if (edit.action === 'delete') {
        if (!model.missingFromCatalog || model.enabled !== false) {
          throw new QoderRequestError('Only unchecked models missing from the catalog can be deleted.')
        }
        return models.filter(candidate => candidate.id !== model.id)
      }
      const tokenCount = model.contextOptions?.[edit.tierKey]?.tokenCount
      if (model.enabled === false || typeof tokenCount !== 'number' || !Number.isFinite(tokenCount) || tokenCount <= 0) {
        throw new QoderRequestError('The Qoder context tier is unavailable.')
      }
      return models.map(candidate => candidate.id === model.id
        ? { ...candidate, contextTier: edit.tierKey, contextWindow: tokenCount }
        : candidate)
    })
    const committed = pending.then(models => models!)
    state.editing = committed
    try {
      const models = await committed
      state.failure = undefined
      this.publish(region)
      return models
    } finally {
      if (state.editing === committed) state.editing = undefined
    }
  }

  private async writeCatalog(
    region: QoderRegion,
    reconcile: (models: readonly QoderCatalogModel[]) => readonly QoderCatalogModel[],
    { signal, allowUnavailable, onWrite }: {
      signal?: AbortSignal
      allowUnavailable?: boolean
      onWrite?(write: CatalogWrite): void
    } = {},
  ): Promise<readonly QoderCatalogModel[] | undefined> {
    const settings = this.settings
    const delays = this.options.persistenceConflictBackoffMs ?? defaultPersistenceConflictBackoffMs
    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted || this.disposed) throw aborted()
      const snapshot = this.settings === settings ? settings?.read(region) : undefined
      if (!snapshot || !settings) {
        if (allowUnavailable) return
        throw new Error('Qoder catalog settings are unavailable.')
      }
      const updated = reconcile(snapshot.models)
      if (hasSameQoderDiscoveryMetadata(snapshot.models, updated)) return snapshot.models
      const models = modelsFor(Config({ modelsByRegion: { [region]: updated } }), region)
      if (hasSameQoderDiscoveryMetadata(snapshot.models, models)) return snapshot.models
      try {
        onWrite?.({ before: snapshot.models, after: models })
        await settings.write(region, models, snapshot.revision)
        if (this.settings !== settings) throw new Error('Qoder catalog settings changed during the save.')
        return models
      } catch (error) {
        if (!(error instanceof SettingsConflictError) || attempt >= delays.length) throw error
        const delay = delays[attempt] ?? 0
        if (delay > 0) await new Promise<void>(resolve => setTimeout(resolve, delay))
      }
    }
  }

  bindSettings(settings: QoderCatalogSettings | undefined): void {
    this.settings = settings
    this.retryPersistence()
  }

  /** Persist an accepted discovery when settings first become available. */
  retryPersistence(): void {
    this.observeTransport()
    const region = this.activeRegion!
    const state = this.catalogs[region]
    if (!this.disposed && state.needsPersistence && !state.running && !state.editing && this.settings?.read(region)) {
      this.startRefresh(region, false, state.models)
    }
  }

  dispose(): void {
    this.disposed = true
    this.settings = undefined
    for (const state of Object.values(this.catalogs)) state.running?.controller.abort()
    this.listeners.clear()
  }
}
