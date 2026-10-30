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
  private active = false
  private lifetime = 0
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
    this.unsubscribe = this.operations.subscribeSessionTiers?.(this.scope, () => { void this.refresh() })
    void this.refresh()
  }
  dispose() { this.active = false; this.generation++; this.unsubscribe?.(); this.unsubscribe = undefined }
  private matches(value: QoderSessionTierSelection | undefined): value is QoderSessionTierSelection {
    return !!value && value.region === this.scope.region && value.sessionId === this.scope.sessionId && value.modelId === this.scope.modelId
  }
  async refresh() {
    if (!this.active) return
    const generation = ++this.generation
    this.publish({ loading: true, operationError: undefined })
    try {
      const result = await this.operations.readSessionTier?.(this.scope)
      const selection = result?.ok ? result.value : undefined
      if (this.active && generation === this.generation) {
        this.publish(this.matches(selection) ? { selection, loading: false, error: false, operationError: undefined } : { loading: false, error: true, operationError: result && !result.ok ? result.error : undefined })
      }
    } catch {
      if (this.active && generation === this.generation) this.publish({ loading: false, error: true })
    }
  }
  async select(tierKey: string) {
    if (!this.active || this.snapshot.loading || this.snapshot.saving || !this.snapshot.selection) return
    if (tierKey === this.snapshot.selection.tierKey && !this.snapshot.error) return
    const generation = ++this.generation
    const lifetime = this.lifetime
    this.publish({ saving: true, error: false, operationError: undefined })
    try {
      const { sessionId, modelId, region } = this.scope
      const result = await this.operations.setSessionTier?.(sessionId, modelId, tierKey, region)
      const selection = result?.ok ? result.value : undefined
      if (this.active && generation === this.generation) {
        this.publish(this.matches(selection) ? { selection, error: false, operationError: undefined } : { error: true, operationError: result && !result.ok ? result.error : undefined })
      }
    } catch {
      if (this.active && generation === this.generation) this.publish({ error: true })
    } finally {
      if (this.active && lifetime === this.lifetime) this.publish({ saving: false })
    }
  }
}
