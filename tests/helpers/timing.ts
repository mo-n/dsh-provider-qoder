import type { TestContext } from 'node:test'

export function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}

/** Drain runnable I/O/stream continuations once, without advancing elapsed time. */
export const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve))

/** Native AbortSignal.timeout uses an internal clock that node:test does not mock. */
export function mockTime(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-10-01T00:00:00Z') })
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), milliseconds)
    return controller.signal
  })
  // TestContext also restores these automatically; explicit cleanup documents isolation=none.
  t.after(() => { t.mock.restoreAll(); t.mock.timers.reset() })
  return t.mock.timers
}
