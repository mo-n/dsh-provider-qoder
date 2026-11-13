import { randomUUID } from 'node:crypto'

/** Keep a refusal pending until a client finishes showing its toast. */
export class QoderModelRefusals {
  private readonly notices = new Map<string, string>()

  report(sessionId: string): void {
    this.notices.set(sessionId, randomUUID())
  }

  read(sessionId: string): string | undefined {
    return this.notices.get(sessionId)
  }

  dismiss(sessionId: string, id: string): void {
    if (this.notices.get(sessionId) === id) this.clear(sessionId)
  }

  clear(sessionId: string): void {
    this.notices.delete(sessionId)
  }

  dispose(): void {
    this.notices.clear()
  }
}
