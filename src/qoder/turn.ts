/** Immutable host turn handle. Reuse the same object for every request of a turn.
 * The host owns its lifetime; in-flight requests retain it after the turn ends.
 */
export interface QoderHostRun {
  readonly id: string
  /** Reject dispatch after provider unload starts, even for a previously captured run. */
  readonly assertDispatchAllowed?: () => void
  /** Register transport-owned finalization, including work prepared after the boundary closed. */
  readonly onEnd?: (finish: (end: QoderRunEnd) => Promise<void>) => void
}

/** Terminal or abandonment state of the host turn, independent of model-step completion. */
export interface QoderRunEnd {
  readonly stage: 'complete' | 'abort' | 'error'
  readonly endedAt: number
}
