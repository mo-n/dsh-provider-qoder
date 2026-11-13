/** Queue polling and lease cleanup, scoped to one logical model call. */
import { randomUUID } from 'node:crypto'
import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import { QoderLlmError } from '../errors.ts'
import { defaultModelQueueMaxWaitMs, type QoderQueueStatus, type QoderQueueUpdate, type QoderQueueLease } from '../queue.ts'
import type { QoderRegion } from '../region.ts'
import { getQoderQueueFinishUrl, getQoderQueueStatusUrl } from './endpoints.ts'
import type { QoderLogger } from './logging.ts'
import { buildAuthHeaders, type CosyCredentials } from './wire/cosy.ts'
import { parseQueueStatus } from './wire/queue.ts'

export interface QueueClock {
  now(): number
  sleep(ms: number, signal?: AbortSignal): Promise<void>
}

export function queueFailure(message: string, code = 'QODER_QUEUE_FAILED'): QoderLlmError {
  // Dedicated codes deliberately stay outside DSH's default transient retry set.
  const error = new QoderLlmError(message, code)
  error.upstreamCode = '10605'
  return error
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new QoderLlmError('Qoder request was aborted.', 'ABORTED')
}

export const queueClock: QueueClock = {
  now: () => performance.now(),
  sleep: (ms, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new QoderLlmError('Qoder request was aborted.', 'ABORTED')); return }
    const abort = (): void => {
      clearTimeout(timer)
      reject(new QoderLlmError('Qoder request was aborted.', 'ABORTED'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', abort, { once: true })
  }),
}

/** A cancellable deadline with no surviving timers, including failed operations. */
async function bounded<T>(ms: number, signal: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  checkAbort(signal)
  const controller = new AbortController()
  const onAbort = (): void => controller.abort(signal?.reason)
  signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error('Qoder queue operation timed out.')), Math.max(1, Math.ceil(ms)))
  let stop: () => void = () => {}
  const interrupted = new Promise<never>((_resolve, reject) => {
    stop = () => reject(signal?.aborted
      ? new QoderLlmError('Qoder request was aborted.', 'ABORTED')
      : queueFailure('Qoder queue operation timed out.'))
    controller.signal.addEventListener('abort', stop, { once: true })
  })
  try {
    return await Promise.race([run(controller.signal), interrupted])
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    controller.signal.removeEventListener('abort', stop)
    controller.abort()
  }
}

async function readBody(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const cancel = (): void => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ''
  try {
    checkAbort(signal)
    while (true) {
      const { done, value } = await reader.read()
      checkAbort(signal)
      if (done) return text + decoder.decode()
      bytes += value.byteLength
      if (bytes > 65_536) throw queueFailure('Qoder queue response exceeded its size limit.')
      text += decoder.decode(value, { stream: true })
    }
  } finally {
    signal.removeEventListener('abort', cancel)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export function queueInterval(seconds?: number): number {
  if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0) {
    return Math.min(30_000, Math.max(500, seconds * 1000))
  }
  return 10_000
}

export interface ModelQueueOptions {
  region: QoderRegion
  subscriberId?: string
  runStartedAt?: number
  onLease?: (lease: QoderQueueLease) => boolean
  fetch: typeof fetch
  requestSetId: string
  sessionId: string
  /** DSH session identity, separate from the upstream session ID. */
  dshSessionId?: string
  model: string
  modelName?: string
  signal?: AbortSignal
  maxWaitMs?: number
  credentials: (refresh: boolean, signal: AbortSignal) => Promise<CosyCredentials>
  onUpdate?: (update: QoderQueueUpdate) => void
  logger?: QoderLogger
  clock?: QueueClock
}

/**
 * Coordinates queue-lease cleanup for requests without a host lease owner that share one
 * upstream request set. DSH-owned turns use `onLease` and retain/release
 * through their host run; hostless calls have no host owner, so their server
 * lease must remain alive until every request using the set has finished.
 */
interface AnonymousLeaseScope {
  references: number
  elapsed: () => number
  leases: Map<string, (elapsedMs: number) => Promise<void>>
  cleanup?: Promise<void>
}

const anonymousLeaseScopes = new Map<string, AnonymousLeaseScope>()

interface AnonymousLeaseHandle {
  entered(model: string, release: (elapsedMs: number) => Promise<void>): void
  ready(): Promise<void>
  finish(): Promise<void>
}

function anonymousLeaseHandle(key: string, clock: QueueClock): AnonymousLeaseHandle {
  let scope = anonymousLeaseScopes.get(key)
  if (scope === undefined) {
    scope = { references: 0, elapsed: () => 0, leases: new Map() }
    anonymousLeaseScopes.set(key, scope)
  }
  if (scope.references === 0) {
    const startedAt = clock.now()
    scope.elapsed = () => Math.max(0, clock.now() - startedAt)
  }
  scope.references += 1
  let finished = false
  return {
    ready: () => scope!.cleanup ?? Promise.resolve(),
    entered(model, release) {
      // Keep the first callback for a model. It owns the credentials and
      // endpoint bound to this request set, while all callers share it.
      if (!scope!.leases.has(model)) scope!.leases.set(model, release)
    },
    async finish() {
      if (finished) return
      finished = true
      scope!.references -= 1
      if (scope!.references > 0) return
      const elapsedMs = scope!.elapsed()
      const leases = [...scope!.leases.values()]
      scope!.leases.clear()
      const releaseCleanup = (): Promise<void> => Promise.allSettled(leases.map(release => release(elapsedMs))).then(() => undefined)
      const cleanup = scope!.cleanup === undefined
        ? releaseCleanup()
        : scope!.cleanup.then(releaseCleanup)
      scope!.cleanup = cleanup
      await cleanup
      if (scope!.cleanup === cleanup) {
        scope!.cleanup = undefined
        if (scope!.references === 0 && anonymousLeaseScopes.get(key) === scope) {
          anonymousLeaseScopes.delete(key)
        }
      }
    },
  }
}

export class ModelQueue {
  private readonly callId = randomUUID()
  private readonly options: ModelQueueOptions
  private readonly clock: QueueClock
  private readonly maxWaitMs: number
  private readonly models = new Set<string>()
  private readonly deferred = new Set<string>()
  private readonly anonymousLease: AnonymousLeaseHandle | undefined
  private waitMs = 0
  private recoveries = 0

  constructor(options: ModelQueueOptions) {
    this.options = options
    this.clock = options.clock ?? queueClock
    this.maxWaitMs = options.maxWaitMs ?? defaultModelQueueMaxWaitMs
    if (!Number.isSafeInteger(this.maxWaitMs) || this.maxWaitMs <= 0 || this.maxWaitMs > 2_147_483_647) {
      throw new Error('modelQueueMaxWaitMs must be a positive integer no greater than 2147483647')
    }
    // Calls with no host lease owner share cleanup even if they have a session.
    this.anonymousLease = !options.dshSessionId || options.onLease === undefined
      ? anonymousLeaseHandle(JSON.stringify([options.region, options.subscriberId, options.requestSetId, options.model]), this.clock)
      : undefined
  }

  private publish(update: QoderQueueUpdate): void {
    try { this.options.onUpdate?.(update) } catch {
      this.options.logger?.warn?.('[Qoder Queue] Status observer failed')
    }
  }

  clear(): void {
    this.publish({ type: 'clear', callId: this.callId })
  }

  /** Wait for a prior request-set lease release before reusing its identity. */
  async ready(): Promise<void> {
    const signal = this.options.signal
    checkAbort(signal)
    const barrier = this.anonymousLease?.ready()
    if (signal === undefined || barrier === undefined) {
      await barrier
      return
    }
    let abort!: () => void
    const interrupted = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new QoderLlmError('Qoder request was aborted.', 'ABORTED'))
      signal.addEventListener('abort', abort, { once: true })
    })
    try {
      await Promise.race([barrier, interrupted])
    } finally {
      signal.removeEventListener('abort', abort)
    }
  }

  /** Register even a queue signal rejected by the output guard, so cleanup still runs. */
  entered(status: QoderQueueStatus): void {
    const model = status.modelKey ?? this.options.model
    if (this.models.has(model)) return
    this.models.add(model)
    if (this.anonymousLease !== undefined) {
      this.anonymousLease.entered(model, elapsedMs => this.release(model, elapsedMs))
      return
    }
    if (this.options.dshSessionId && this.options.onLease) {
      const key = JSON.stringify([this.options.region, this.options.subscriberId, this.options.requestSetId, model])
      if (this.options.onLease({
        key,
        sessionId: this.options.dshSessionId,
        release: () => this.release(model, Math.max(0, Date.now() - (this.options.runStartedAt ?? Date.now()))),
      })) this.deferred.add(model)
    }
  }

  async wait(initial: QoderQueueStatus, requestId: string): Promise<void> {
    this.entered(initial)
    if (this.recoveries >= 10) throw queueFailure('Qoder queue recovery limit reached.', 'QODER_QUEUE_LIMIT')
    const started = this.clock.now()
    const remaining = (): number => this.maxWaitMs - this.waitMs - (this.clock.now() - started)
    const assertTime = (): void => {
      checkAbort(this.options.signal)
      if (remaining() <= 0) throw queueFailure('Qoder model queue wait timed out.', 'QODER_QUEUE_TIMEOUT')
    }
    let status = initial
    let failures = 0
    let first = true
    try {
      while (true) {
        assertTime()
        if (this.options.dshSessionId !== undefined) {
          this.publish({ type: 'waiting', snapshot: {
            callId: this.callId,
            sessionId: this.options.dshSessionId,
            model: status.modelKey ?? this.options.model,
            ...this.options.modelName ? { modelName: this.options.modelName } : {},
            ...status.queueCount === undefined ? {} : { queueCount: status.queueCount },
            ...status.waitTime === undefined ? {} : { waitTimeMs: status.waitTime * 1000 },
            ...status.serviceAvailable === undefined ? {} : { serviceAvailable: status.serviceAvailable },
            waitElapsedMs: this.waitMs + Math.max(0, this.clock.now() - started),
            maxWaitMs: this.maxWaitMs,
            updatedAt: Date.now(),
          } })
        }
        if (!first) await this.clock.sleep(Math.min(queueInterval(status.retryAfterSeconds), remaining()), this.options.signal)
        first = false
        assertTime()
        try {
          const next = await this.poll(status, requestId, remaining())
          status = { ...next, modelKey: next.modelKey ?? status.modelKey, queueType: next.queueType ?? status.queueType }
          failures = 0
          this.entered(status)
          if (status.isQueued === false && status.serviceAvailable !== false) {
            if (status.retryAfterSeconds !== undefined && status.retryAfterSeconds > 0) {
              await this.clock.sleep(Math.min(queueInterval(status.retryAfterSeconds), remaining()), this.options.signal)
            }
            assertTime()
            this.recoveries++
            return
          }
          if (status.isQueued !== true && status.serviceAvailable !== false) {
            throw queueFailure('Qoder returned an invalid queue state.', 'QODER_QUEUE_INVALID_STATE')
          }
        } catch (error) {
          assertTime()
          if (error instanceof QoderLlmError && ['QODER_QUEUE_UNAVAILABLE', 'QODER_QUEUE_INVALID_STATE', 'QODER_QUEUE_IDENTITY'].includes(error.code)) throw error
          if (++failures >= 3) throw queueFailure('Qoder queue status polling failed three consecutive times.')
          this.options.logger?.warn?.('[Qoder Queue] Status poll failed; will retry', { failures })
          status = { ...status, retryAfterSeconds: undefined }
        }
      }
    } finally {
      this.waitMs += Math.max(0, this.clock.now() - started)
      this.clear()
    }
  }

  private async poll(status: QoderQueueStatus, requestId: string, remainingMs: number): Promise<QoderQueueStatus> {
    const url = getQoderQueueStatusUrl(this.options.region, {
      requestSetId: this.options.requestSetId,
      modelKey: status.modelKey ?? this.options.model,
      queueType: status.queueType,
    })
    return bounded(remainingMs, this.options.signal, async signal => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const credentials = await this.options.credentials(attempt > 0, signal)
        checkAbort(signal)
        const outcome = await bounded(Math.min(30_000, remainingMs), signal, async httpSignal => {
          const response = await this.options.fetch(url, {
            method: 'GET',
            headers: {
              ...attributionHeaders(),
              ...buildAuthHeaders(null, url, credentials),
              Accept: 'application/json',
              'Accept-Encoding': 'identity',
              'X-Request-Id': requestId,
              'X-Session-ID': this.options.sessionId,
            },
            signal: httpSignal,
          })
          return { status: response.status, ok: response.ok, body: await readBody(response, httpSignal) }
        })
        if ((outcome.status === 401 || outcome.status === 403) && attempt === 0) continue
        if (outcome.status === 404) throw queueFailure('Qoder queue endpoint is unavailable.', 'QODER_QUEUE_UNAVAILABLE')
        if (!outcome.ok) throw queueFailure(`Qoder queue status returned HTTP ${outcome.status}.`)
        const parsed = parseQueueStatus(outcome.body)
        if (!parsed) throw queueFailure('Qoder returned a malformed queue status.')
        return parsed
      }
      throw queueFailure('Qoder queue authentication failed.')
    })
  }

  /** Best-effort cleanup has an independent signal even after caller cancellation. */
  async finish(elapsedMs: number): Promise<void> {
    this.clear()
    if (this.anonymousLease !== undefined) {
      await this.anonymousLease.finish()
      this.models.clear()
      return
    }
    const models = [...this.models].filter(model => !this.deferred.has(model))
    this.models.clear()
    await Promise.allSettled(models.map(model => this.release(model, elapsedMs)))
  }

  private async release(model: string, elapsedMs: number): Promise<void> {
    try {
      await bounded(3000, undefined, async signal => {
        const credentials = await this.options.credentials(false, signal)
        checkAbort(signal)
        const url = getQoderQueueFinishUrl(this.options.region)
        const body = JSON.stringify({ payload: JSON.stringify({
          model_key: model,
          request_set_id: this.options.requestSetId,
          user_id: credentials.userID,
          time_consumed: Math.max(0, Math.round(elapsedMs)),
        }), encodeVersion: '1' })
        const response = await this.options.fetch(url, {
          method: 'POST',
          headers: {
            ...attributionHeaders(),
            ...buildAuthHeaders(body, url, credentials),
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-Request-Id': randomUUID(),
          },
          body,
          signal,
        })
        await readBody(response, signal)
        if (!response.ok) throw queueFailure('Qoder lease release failed.')
      })
    } catch {
      this.options.logger?.warn?.('[Qoder Queue] Finish failed; server TTL will release the lease')
    }
  }
}
