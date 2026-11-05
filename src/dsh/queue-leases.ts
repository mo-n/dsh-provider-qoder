/** Correlate transport-owned release actions with committed DSH turn boundaries. */
import { randomUUID } from 'node:crypto'
import type { QoderQueueLease, QoderQueueOwner } from '../qoder/queue.ts'
import type { QoderHostRun, QoderRunEnd } from '../qoder/turn.ts'
import type { TurnEndReason } from '@deepseek-ai/dsh-session/types'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session'

/** Bind committed boundaries and recover ownership when loaded during an open turn. */
export function bindQoderQueueLeases(ctx: Context, leases: QoderQueueLeases): void {
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') leases.start(session.id, event.data.turn)
    if (event.type === 'turn/end') void leases.end(session.id, event.data.turn, {
      stage: qoderEndStage(event.data.reason), endedAt: event.time,
    })
  })
  ctx.on('agent/request', async ({ agent, turn }, next) => {
    leases.start(agent.session.id, turn)
    return next()
  })
}

function qoderEndStage(reason: TurnEndReason): QoderRunEnd['stage'] {
  switch (reason.kind) {
    case 'completed': return 'complete'
    case 'aborted': case 'blocked': case 'interrupted': case 'forked': return 'abort'
    default: return 'error'
  }
}

interface HostedRun {
  turn: number
  run: QoderHostRun
  leases: Map<string, QoderQueueLease>
  finishers: Set<(end: QoderRunEnd) => Promise<void>>
  end?: QoderRunEnd
}

export class QoderQueueLeases {
  private readonly runs = new Map<string, HostedRun>()
  private readonly pending = new Set<Promise<unknown>>()
  private disposed = false

  start(sessionId: string, turn: number): void {
    if (this.disposed || this.runs.get(sessionId)?.turn === turn) return
    // A replacement must detach old actions before a newer turn can retain leases.
    void this.end(sessionId)
    const owner: HostedRun = {
      turn, leases: new Map(), finishers: new Set(),
      run: Object.freeze({ id: randomUUID(), onEnd: (finish: (end: QoderRunEnd) => Promise<void>) => {
        // A request may finish preparation after turn/end. Keep its original
        // terminal state rather than attaching its business to the current turn.
        if (owner.end) void this.cleanup([() => finish(owner.end!)])
        else owner.finishers.add(finish)
      } }),
    }
    this.runs.set(sessionId, owner)
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
      run: owner.run,
      retain: lease => lease.sessionId === sessionId && this.runs.get(sessionId) === owner && this.retain(lease),
    }
  }

  async end(sessionId: string, turn?: number, end: QoderRunEnd = { stage: 'abort', endedAt: Date.now() }): Promise<void> {
    const run = this.runs.get(sessionId)
    if (!run || (turn !== undefined && turn !== run.turn)) return
    this.runs.delete(sessionId)
    run.end = Object.freeze({ ...end })
    await this.cleanup([
      ...[...run.leases.values()].map(lease => () => lease.release()),
      ...[...run.finishers].map(finish => () => finish(run.end!)),
    ])
    run.leases.clear()
    run.finishers.clear()
  }

  private async cleanup(actions: Array<() => Promise<void>>): Promise<void> {
    const cleanup = Promise.allSettled(actions.map(action => Promise.resolve().then(action)))
    this.pending.add(cleanup)
    try { await cleanup } finally { this.pending.delete(cleanup) }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await Promise.allSettled([...this.runs.keys()].map(id => this.end(id)))
    await Promise.allSettled([...this.pending])
  }
}
