/** Correlate transport-owned release actions with committed DSH turn boundaries. */
import { randomUUID } from 'node:crypto'
import type { QoderQueueLease, QoderQueueOwner } from '../qoder/queue.ts'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session'

/** Bind committed boundaries and recover ownership when loaded during an open turn. */
export function bindQoderQueueLeases(ctx: Context, leases: QoderQueueLeases): void {
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') leases.start(session.id, event.data.turn)
    if (event.type === 'turn/end') void leases.end(session.id, event.data.turn)
  })
  ctx.on('agent/request', async ({ agent, turn }, next) => {
    leases.start(agent.session.id, turn)
    return next()
  })
}

export class QoderQueueLeases {
  private readonly runs = new Map<string, { turn: number; runId: string; leases: Map<string, QoderQueueLease> }>()
  private readonly pending = new Set<Promise<unknown>>()
  private disposed = false

  start(sessionId: string, turn: number): void {
    if (this.disposed || this.runs.get(sessionId)?.turn === turn) return
    // A replacement must detach old actions before a newer turn can retain leases.
    void this.end(sessionId)
    this.runs.set(sessionId, { turn, runId: randomUUID(), leases: new Map() })
  }

  retain = (lease: QoderQueueLease): boolean => {
    const run = this.runs.get(lease.sessionId)
    if (this.disposed || !run) return false
    if (!run.leases.has(lease.key)) run.leases.set(lease.key, lease)
    return true
  }

  /** Bind ownership before provider I/O; a late old call cannot join a newer turn. */
  capture = (sessionId: string): QoderQueueOwner | undefined => {
    const owner = this.runs.get(sessionId)
    if (!owner || this.disposed) return undefined
    return {
      runId: owner.runId,
      retain: lease => lease.sessionId === sessionId && this.runs.get(sessionId) === owner && this.retain(lease),
    }
  }

  async end(sessionId: string, turn?: number): Promise<void> {
    const run = this.runs.get(sessionId)
    if (!run || (turn !== undefined && turn !== run.turn)) return
    this.runs.delete(sessionId)
    const cleanup = Promise.allSettled([...run.leases.values()].map(lease => Promise.resolve().then(() => lease.release())))
    this.pending.add(cleanup)
    try { await cleanup } finally { this.pending.delete(cleanup) }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await Promise.allSettled([...this.runs.keys()].map(id => this.end(id)))
    await Promise.allSettled([...this.pending])
  }
}
