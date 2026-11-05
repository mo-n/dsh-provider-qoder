import type { QoderRpcOutput, QoderRpcResult } from '../dsh/rpc-channel.ts'
import type { QoderRpcCaller } from './rpc-client.ts'

const bootstrapAttempts = 3
const bootstrapRequestTimeout = 5_000
const bootstrapRetryDelays = [250, 500] as const

type BootstrapRpcResult = QoderRpcResult<QoderRpcOutput<'bootstrap'>>
type BootstrapAttempt =
  | { kind: 'result'; result: BootstrapRpcResult }
  | { kind: 'timeout' }
  | { kind: 'aborted' }

function transientBootstrapFailure(result: BootstrapRpcResult): boolean {
  if (result.ok) return false
  if (result.error.code === 'TIMEOUT') return true
  const details = result.error.details as Record<string, unknown> | undefined
  const status = details?.status
  if (typeof status === 'number' && (status === 429 || (status >= 500 && status <= 599))) return true
  return details?.cause === 'connection'
}

function bootstrapFailure(result: BootstrapRpcResult, attempts: number): Error {
  if (result.ok) return new Error('Qoder settings namespace bootstrap returned no failure.')
  return new Error(`Qoder settings namespace bootstrap failed after ${attempts} attempt${attempts === 1 ? '' : 's'} (${result.error.code}): ${result.error.message}`)
}

function waitForBootstrapRetry(signal: AbortSignal, delay: number): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise(resolve => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (value: boolean) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve(value)
    }
    const onAbort = () => finish(false)
    timer = setTimeout(() => finish(true), delay)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) finish(false)
  })
}

async function runBootstrapAttempt(rpc: QoderRpcCaller, signal: AbortSignal): Promise<BootstrapAttempt> {
  if (signal.aborted) return { kind: 'aborted' }
  const attempt = new AbortController()
  const forwardAbort = () => attempt.abort()
  signal.addEventListener('abort', forwardAbort, { once: true })
  let timeout: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  const request = rpc.call('bootstrap', {}, attempt.signal).then(
    result => timedOut ? { kind: 'timeout' as const } : { kind: 'result' as const, result },
    error => timedOut
      ? { kind: 'timeout' as const }
      : signal.aborted || (error instanceof Error && error.name === 'AbortError')
        ? { kind: 'aborted' as const }
        : { kind: 'result' as const, result: {
          ok: false as const,
          error: { code: 'INTERNAL' as const, message: error instanceof Error ? error.message : String(error), details: { cause: 'connection' } },
        } },
  )
  const timeoutResult = new Promise<BootstrapAttempt>(resolve => {
    timeout = setTimeout(() => {
      timedOut = true
      attempt.abort()
      resolve({ kind: 'timeout' })
    }, bootstrapRequestTimeout)
  })
  let onAbort: (() => void) | undefined
  const abortResult = new Promise<BootstrapAttempt>(resolve => {
    if (signal.aborted) {
      attempt.abort()
      resolve({ kind: 'aborted' })
      return
    }
    onAbort = () => {
      attempt.abort()
      resolve({ kind: 'aborted' })
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    const outcome = await Promise.race([request, timeoutResult, abortResult])
    if (signal.aborted) return { kind: 'aborted' }
    if (timedOut) return { kind: 'timeout' }
    return outcome
  } finally {
    // An HTTP error can return before its response body is consumed. Abort the
    // per-attempt controller on every exit so that such a body is released,
    // while the race above still bounds transports that ignore abort signals.
    attempt.abort()
    if (timeout !== undefined) clearTimeout(timeout)
    signal.removeEventListener('abort', forwardAbort)
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
    // A fetch implementation may ignore AbortSignal. The race above bounds
    // startup, so consume its eventual settlement without letting it escape.
    void request.catch(() => {})
  }
}

/** Read the host-owned settings namespace with bounded transient recovery. */
export async function readQoderSettingsNamespace(rpc: QoderRpcCaller, signal: AbortSignal): Promise<string | undefined> {
  for (let attempt = 1; attempt <= bootstrapAttempts; attempt++) {
    const outcome = await runBootstrapAttempt(rpc, signal)
    if (outcome.kind === 'aborted') return undefined
    if (outcome.kind === 'timeout') {
      if (attempt === bootstrapAttempts) throw new Error(`Qoder settings namespace bootstrap timed out after ${bootstrapAttempts} attempts.`)
    } else if (outcome.result.ok) {
      const namespace = outcome.result.value?.settingsNamespace
      if (typeof namespace !== 'string' || !namespace.trim()) {
        throw new Error('Qoder settings namespace bootstrap returned no namespace.')
      }
      return namespace
    } else {
      if (!transientBootstrapFailure(outcome.result) || attempt === bootstrapAttempts) {
        throw bootstrapFailure(outcome.result, attempt)
      }
    }
    if (!await waitForBootstrapRetry(signal, bootstrapRetryDelays[attempt - 1] ?? bootstrapRetryDelays.at(-1)!)) return undefined
  }
  return undefined
}
