/** Immutable host turn handle. Reuse the same object for every request of a turn.
 * The host owns its lifetime; in-flight requests retain it after the turn ends.
 */
export interface QoderHostRun {
  readonly id: string
}
