/** Browser-safe queue status; all durations exposed to the UI are milliseconds. */
export interface QoderQueueStatus {
  isQueued?: boolean
  modelKey?: string
  queueCount?: number
  queueType?: string
  serviceAvailable?: boolean
  retryAfterSeconds?: number
  /** Provider estimate in seconds. */
  waitTime?: number
}

export interface QoderQueueSnapshot {
  callId: string
  sessionId: string
  model: string
  /** Advertised name of the selected model, independent of its upstream key. */
  modelName?: string
  queueCount?: number
  waitTimeMs?: number
  serviceAvailable?: boolean
  waitElapsedMs: number
  maxWaitMs: number
  updatedAt: number
}

export type QoderQueueUpdate =
  | { type: 'waiting'; snapshot: QoderQueueSnapshot }
  | { type: 'clear'; callId: string }

export const defaultModelQueueMaxWaitMs = 60 * 60 * 1000

/** A transport-owned release action retained until its DSH turn ends. */
export interface QoderQueueLease {
  key: string
  sessionId: string
  release(): Promise<void>
}

/** Captured host-run identity and the matching lease retention capability. */
export interface QoderQueueOwner {
  readonly runId: string
  retain(lease: QoderQueueLease): boolean
}
