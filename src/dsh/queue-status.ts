/** Transient plugin-owned snapshots, independent of transport instance replacement. */
import type { QoderQueueSnapshot, QoderQueueUpdate } from '../qoder/queue.ts'

export class QoderQueueStatusStore {
  private readonly calls = new Map<string, QoderQueueSnapshot>()
  private active = true

  update = (event: QoderQueueUpdate): void => {
    if (!this.active) return
    if (event.type === 'clear') this.calls.delete(event.callId)
    else this.calls.set(event.snapshot.callId, { ...event.snapshot })
  }

  read(sessionId: string): QoderQueueSnapshot[] {
    return [...this.calls.values()].filter(value => value.sessionId === sessionId).map(value => ({ ...value }))
  }

  dispose(): void {
    this.active = false
    this.calls.clear()
  }
}
