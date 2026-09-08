/** PAT exchange and in-memory Qoder job-token lifecycle. */

import type { CosyCredentials } from './cosy.ts'
import { getQoderExchangeUrl, getQoderUserInfoUrl, type QoderRegion } from './endpoints.ts'
import { QoderLlmError, qoderHttpError } from './errors.ts'
import { redactLogPayload, redactLogValue, type QoderLogger } from './logging.ts'
import { getMachineId } from './machine-id.ts'

const userAgent = 'dsh-provider-qoder'
const expiryBufferMs = 5 * 60 * 1000
const defaultExpiryMs = 24 * 60 * 60 * 1000
const defaultAuthTimeoutMs = 15_000

interface CachedEntry {
  creds: CosyCredentials
  expiresAt: number
}

interface InFlightEntry {
  promise: Promise<CosyCredentials>
  controller: AbortController
  waiters: number
  settled: boolean
  timeout: ReturnType<typeof setTimeout>
}

export interface QoderAuthServiceOptions {
  fetch?: typeof fetch
  timeoutMs?: number
  resolveMachineId?: () => string
  resolveRegion?: () => QoderRegion
  region?: QoderRegion
  logger?: QoderLogger
}

function abortedError(): QoderLlmError {
  return new QoderLlmError('Qoder authentication was aborted.', 'ABORTED')
}

async function waitForFlight(
  promise: Promise<CosyCredentials>,
  signal?: AbortSignal,
): Promise<CosyCredentials> {
  if (signal === undefined) return promise
  if (signal.aborted) throw abortedError()

  return new Promise<CosyCredentials>((resolve, reject) => {
    const onAbort = (): void => reject(abortedError())
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

export class QoderAuthService {
  private readonly cache = new Map<string, CachedEntry>()
  private readonly inFlight = new Map<string, InFlightEntry>()
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly resolveMachineId: () => string
  private readonly resolveRegion?: () => QoderRegion
  private region?: QoderRegion
  private readonly logger?: QoderLogger

  constructor(options: QoderAuthServiceOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.timeoutMs = options.timeoutMs ?? defaultAuthTimeoutMs
    this.resolveMachineId = options.resolveMachineId ?? getMachineId
    this.resolveRegion = options.resolveRegion
    this.region = options.region
    this.logger = options.logger
  }

  setRegion(region: QoderRegion): void {
    this.region = region
  }

  currentRegion(): QoderRegion {
    if (this.resolveRegion) return this.resolveRegion()
    return this.region ?? 'global'
  }

  clear(pat?: string): void {
    if (pat) {
      for (const key of this.cache.keys()) {
        if (key.endsWith(`:${pat}`) || key === pat) this.cache.delete(key)
      }
    } else {
      this.cache.clear()
    }
  }


  async getCredentials(
    pat: string,
    signal?: AbortSignal,
    region?: QoderRegion,
  ): Promise<CosyCredentials> {
    if (!pat || typeof pat !== 'string') {
      throw new QoderLlmError(
        'Qoder Personal Access Token is missing or invalid. Configure Qoder in the Qoder settings page.',
        'MISSING_CREDENTIAL',
      )
    }
    if (signal?.aborted) throw abortedError()

    const effectiveRegion = region ?? this.currentRegion()
    const cacheKey = `${effectiveRegion}:${pat}`

    const cached = this.cache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now() + expiryBufferMs) return cached.creds

    let entry = this.inFlight.get(cacheKey)
    if (entry === undefined) {
      const controller = new AbortController()
      const created = {} as InFlightEntry
      created.controller = controller
      created.waiters = 0
      created.settled = false
      created.timeout = setTimeout(() => controller.abort('authentication timeout'), this.timeoutMs)
      created.promise = this.exchangeAndResolve(pat, controller.signal, effectiveRegion).finally(() => {
        created.settled = true
        clearTimeout(created.timeout)
        if (this.inFlight.get(cacheKey) === created) this.inFlight.delete(cacheKey)
      })
      entry = created
      this.inFlight.set(cacheKey, entry)
    }

    entry.waiters++
    try {
      return await waitForFlight(entry.promise, signal)
    } finally {
      entry.waiters--
      if (entry.waiters === 0 && !entry.settled) entry.controller.abort('all callers aborted')
    }
  }

  private async exchangeAndResolve(
    pat: string,
    signal: AbortSignal,
    region: QoderRegion,
  ): Promise<CosyCredentials> {
    let jobToken: string
    let expiresAt = Date.now() + defaultExpiryMs

    try {
      const url = getQoderExchangeUrl(region)
      this.logger?.debug?.('[Qoder Auth] Exchanging PAT for job token', { url, region })
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'accept': 'application/json',
          'user-agent': userAgent,
          'cosy-version': '1.0.1',
          'cosy-clienttype': '5',
        },
        body: JSON.stringify({ personal_token: pat }),
        signal,
      })
      this.logger?.debug?.('[Qoder Auth] Exchange completed', {
        status: response.status,
        statusText: response.statusText,
      })
      if (!response.ok) {
        const errorText = await response.text()
        this.logger?.error?.('[Qoder Auth] Exchange failed', redactLogPayload(errorText))
        throw qoderHttpError(
          `Qoder PAT exchange failed with HTTP status ${response.status}.`,
          response,
        )
      }

      const data = await response.json() as {
        token?: string
        expires_at?: string
        expires_in?: number
      }
      if (!data.token) {
        throw new QoderLlmError('Qoder PAT exchange returned no job token.', 'AUTH')
      }
      jobToken = data.token
      if (data.expires_at) {
        const parsed = Date.parse(data.expires_at)
        if (!Number.isNaN(parsed)) expiresAt = parsed
      } else if (typeof data.expires_in === 'number' && data.expires_in > 0) {
        expiresAt = Date.now() + data.expires_in
      }
    } catch (error: unknown) {
      if (error instanceof QoderLlmError) throw error
      if (signal.aborted) {
        throw new QoderLlmError('Qoder authentication request timed out or was cancelled.', 'TIMEOUT')
      }
      throw new QoderLlmError('Qoder PAT exchange network request failed.', 'TRANSPORT', { cause: error })
    }

    const userInfo = await this.fetchUserInfo(jobToken, signal, region)
    const creds: CosyCredentials = {
      userID: userInfo.userID,
      authToken: jobToken,
      name: userInfo.name || 'Qoder User',
      email: userInfo.email,
      machineID: this.resolveMachineId(),
    }
    const cacheKey = `${region}:${pat}`
    this.cache.set(cacheKey, { creds, expiresAt })
    return creds
  }

  private async fetchUserInfo(
    jobToken: string,
    signal: AbortSignal,
    region: QoderRegion,
  ): Promise<{ userID: string; email: string; name: string }> {
    const url = getQoderUserInfoUrl(region)
    this.logger?.debug?.('[Qoder UserInfo] Requesting subscriber profile', { url })
    try {
      const response = await this.fetchImpl(url, {
        headers: {
          'authorization': `Bearer ${jobToken}`,
          'accept': 'application/json',
          'user-agent': userAgent,
          'cosy-version': '1.0.1',
          'cosy-clienttype': '5',
        },
        signal,
      })
      this.logger?.debug?.('[Qoder UserInfo] Request completed', {
        status: response.status,
        statusText: response.statusText,
      })
      const text = await response.text()
      if (!response.ok) {
        this.logger?.error?.('[Qoder UserInfo] Request failed', redactLogPayload(text))
        throw qoderHttpError(
          `Qoder identity lookup failed with HTTP status ${response.status}.`,
          response,
        )
      }
      let info: {
        id?: string
        email?: string
        name?: string
        username?: string
      }
      try {
        info = JSON.parse(text)
      } catch {
        this.logger?.error?.('[Qoder UserInfo] Invalid JSON response', redactLogPayload(text))
        throw new QoderLlmError('Qoder identity lookup returned invalid JSON.', 'AUTH')
      }
      this.logger?.debug?.('[Qoder UserInfo] Subscriber profile resolved', redactLogValue(info))
      if (!info.id) {
        throw new QoderLlmError('Qoder identity lookup returned no user id.', 'AUTH')
      }
      return {
        userID: info.id,
        email: info.email ?? '',
        name: info.name ?? info.username ?? '',
      }
    } catch (error: unknown) {
      if (error instanceof QoderLlmError) throw error
      if (signal.aborted) {
        throw new QoderLlmError('Qoder identity lookup timed out or was cancelled.', 'TIMEOUT')
      }
      throw new QoderLlmError('Qoder identity lookup network request failed.', 'TRANSPORT', { cause: error })
    }
  }
}
