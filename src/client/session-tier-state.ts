import type { QoderSessionTierScope, QoderSessionTierSelection } from '../dsh/rpc-channel.ts'
import type { OperationError } from './operation-result.ts'
import type { QoderCredentialOperations } from './credential-operations.ts'

type Operations = Pick<QoderCredentialOperations, 'readSessionTier' | 'setSessionTier' | 'subscribeSessionTiers'>
export interface SessionTierSnapshot {
  selection?: QoderSessionTierSelection
  loading: boolean
  saving: boolean
  error: boolean
  operationError?: OperationError
}

/** A mounted view of the host's accepted selection; it owns no manual tier map. */
export class SessionTierState {
  private snapshot: SessionTierSnapshot = { loading: true, saving: false, error: false }
  private readonly listeners = new Set<() => void>()
  private generation = 0
  private readGeneration = 0
  private active = false
  private lifetime = 0
  private revalidateRequested = false
  private preserveQueuedReadError = false
  private inFlightRead?: { loading: boolean }
  private unsubscribe?: () => void
  readonly scope: QoderSessionTierScope
  private readonly operations: Operations
  constructor(scope: QoderSessionTierScope, operations: Operations) { this.scope = scope; this.operations = operations }
  getSnapshot = () => this.snapshot
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(value: Partial<SessionTierSnapshot>) {
    this.snapshot = { ...this.snapshot, ...value }
    for (const listener of this.listeners) listener()
  }
  activate() {
    this.active = true
    this.lifetime++
    this.publish({ saving: false })
    this.unsubscribe = this.operations.subscribeSessionTiers?.(this.scope, () => { void this.revalidate() })
    void this.refresh()
  }
  dispose() {
    this.active = false
    this.generation++
    this.readGeneration++
    this.revalidateRequested = false
    this.preserveQueuedReadError = false
    this.inFlightRead = undefined
    this.unsubscribe?.()
    this.unsubscribe = undefined
  }
  private matches(value: QoderSessionTierSelection | undefined): value is QoderSessionTierSelection {
    return !!value && value.region === this.scope.region && value.sessionId === this.scope.sessionId && value.modelId === this.scope.modelId
  }
  private async read(loading: boolean, preserveError = false): Promise<void> {
    if (!this.active) return
    const generation = this.generation
    const readGeneration = ++this.readGeneration
    const inFlightRead = { loading }
    this.inFlightRead = inFlightRead
    if (loading) this.publish({ loading: true, operationError: undefined })
    try {
      const result = await this.operations.readSessionTier?.(this.scope)
      const selection = result?.ok ? result.value : undefined
      if (this.active && generation === this.generation && readGeneration === this.readGeneration && !this.snapshot.saving) {
        this.publish(this.matches(selection)
          ? { selection, loading: false, ...(preserveError ? {} : { error: false, operationError: undefined }) }
          : { loading: false, error: true, ...(preserveError ? {} : { operationError: result && !result.ok ? result.error : undefined }) })
        this.startQueuedRevalidation()
      }
    } catch {
      if (this.active && generation === this.generation && readGeneration === this.readGeneration && !this.snapshot.saving) {
        this.publish({ loading: false, error: true })
        this.startQueuedRevalidation()
      }
    } finally {
      if (this.inFlightRead === inFlightRead) this.inFlightRead = undefined
    }
  }
  private startQueuedRevalidation(): void {
    // A listener can synchronously start another save from the publish above.
    // Leave the request queued until that save has finished instead of
    // launching a read concurrently with the new write.
    if (!this.revalidateRequested || !this.active || this.snapshot.saving) return
    const preserveError = this.preserveQueuedReadError
    this.revalidateRequested = false
    this.preserveQueuedReadError = false
    void this.read(false, preserveError)
  }
  async refresh() {
    if (!this.active) return
    if (this.snapshot.saving) {
      this.revalidateRequested = true
      return
    }
    this.generation++
    await this.read(true)
  }
  /** Refresh host state after an external change without disabling a usable control. */
  async revalidate() {
    if (!this.active) return
    if (this.snapshot.saving) {
      this.revalidateRequested = true
      return
    }
    await this.read(false)
  }
  async select(tierKey: string) {
    if (!this.active || this.snapshot.loading || this.snapshot.saving || !this.snapshot.selection) return
    if (tierKey === this.snapshot.selection.tierKey && !this.snapshot.error) return
    if (this.inFlightRead?.loading === false) this.revalidateRequested = true
    const generation = ++this.generation
    this.readGeneration++
    const lifetime = this.lifetime
    let writeFailed = false
    this.preserveQueuedReadError = false
    this.publish({ saving: true, error: false, operationError: undefined })
    try {
      const { sessionId, modelId, region } = this.scope
      const result = await this.operations.setSessionTier?.(sessionId, modelId, tierKey, region)
      const selection = result?.ok ? result.value : undefined
      if (this.active && generation === this.generation) {
        if (this.matches(selection)) this.publish({ selection, error: false, operationError: undefined })
        else {
          writeFailed = true
          this.publish({ error: true, operationError: result && !result.ok ? result.error : undefined })
        }
      }
    } catch {
      writeFailed = true
      if (this.active && generation === this.generation) this.publish({ error: true })
    } finally {
      if (this.active && lifetime === this.lifetime) {
        if (writeFailed && this.revalidateRequested) this.preserveQueuedReadError = true
        this.publish({ saving: false })
        this.startQueuedRevalidation()
      }
    }
  }
}
