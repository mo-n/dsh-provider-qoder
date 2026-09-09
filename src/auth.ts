/** PAT exchange and in-memory Qoder job-token lifecycle. */

import type { CosyCredentials } from './cosy.ts'
import { getQoderExchangeUrl, getQoderUserInfoUrl, type QoderRegion } from './endpoints.ts'
import { QoderLlmError, qoderHttpError, qoderRequestId } from './errors.ts'
import { redactLogPayload, redactLogValue, type QoderLogger } from './logging.ts'
import { getMachineId } from './machine-id.ts'
import {
  defaultMaxErrorBytes,
  defaultMaxJsonBytes,
  opaqueCredentialKey,
  readLimitedText,
  retryMetadataRead,
} from './request.ts'

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
  private readonly region: QoderRegion
  private readonly logger?: QoderLogger

  constructor(options: QoderAuthServiceOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.timeoutMs = options.timeoutMs ?? defaultAuthTimeoutMs
    this.resolveMachineId = options.resolveMachineId ?? getMachineId
    this.region = options.region ?? 'global'
    this.logger = options.logger
  }

  clear(pat?: string): void {
    if (pat) {
      this.cache.delete(`${this.region}:${opaqueCredentialKey(pat)}`)
    } else {
      this.cache.clear()
    }
  }


  async getCredentials(
    pat: string,
    signal?: AbortSignal,
  ): Promise<CosyCredentials> {
    if (!pat || typeof pat !== 'string') {
      throw new QoderLlmError(
        'Qoder Personal Access Token is missing or invalid. Configure Qoder in the Qoder settings page.',
        'MISSING_CREDENTIAL',
      )
    }
    if (signal?.aborted) throw abortedError()

    const cacheKey = `${this.region}:${opaqueCredentialKey(pat)}`

    const cached = this.cache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now() + expiryBufferMs) return cached.creds

    let entry = this.inFlight.get(cacheKey)
    if (entry === undefined || entry.controller.signal.aborted) {
      const controller = new AbortController()
      const created = {} as InFlightEntry
      created.controller = controller
      created.waiters = 0
      created.settled = false
      created.timeout = setTimeout(() => controller.abort('authentication timeout'), this.timeoutMs)
      created.promise = this.exchangeAndResolve(pat, controller.signal).finally(() => {
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
      if (entry.waiters === 0 && !entry.settled) {
        if (this.inFlight.get(cacheKey) === entry) this.inFlight.delete(cacheKey)
        entry.controller.abort('all callers aborted')
      }
    }
  }

  private async exchangeAndResolve(
    pat: string,
    signal: AbortSignal,
  ): Promise<CosyCredentials> {
    let jobToken: string
    let expiresAt = Date.now() + defaultExpiryMs

    try {
      const url = getQoderExchangeUrl(this.region)
      const startedAt = performance.now()
      this.logger?.debug?.('[Qoder Auth] Exchanging PAT for job token', { url, region: this.region })
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
        durationMs: Math.round(performance.now() - startedAt),
        ...qoderRequestId(response.headers) === undefined ? {} : { requestId: qoderRequestId(response.headers) },
      })
      const responseText = await readLimitedText(
        response,
        response.ok ? defaultMaxJsonBytes : defaultMaxErrorBytes,
        'Qoder PAT exchange response',
      )
      if (!response.ok) {
        this.logger?.error?.('[Qoder Auth] Exchange failed', redactLogPayload(responseText))
        throw qoderHttpError(
          `Qoder PAT exchange failed with HTTP status ${response.status}.`,
          response,
        )
      }

      let data: { token?: string; expires_at?: string; expires_in?: number }
      try {
        data = JSON.parse(responseText) as typeof data
      } catch {
        throw new QoderLlmError('Qoder PAT exchange returned invalid JSON.', 'MALFORMED_RESPONSE')
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

    const userInfo = await retryMetadataRead(signal, () => this.fetchUserInfo(jobToken, signal))
    const creds: CosyCredentials = {
      userID: userInfo.userID,
      authToken: jobToken,
      name: userInfo.name || 'Qoder User',
      email: userInfo.email,
      machineID: this.resolveMachineId(),
    }
    const cacheKey = `${this.region}:${opaqueCredentialKey(pat)}`
    this.cache.set(cacheKey, { creds, expiresAt })
    return creds
  }

  private async fetchUserInfo(
    jobToken: string,
    signal: AbortSignal,
  ): Promise<{ userID: string; email: string; name: string }> {
    const url = getQoderUserInfoUrl(this.region)
    const startedAt = performance.now()
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
        durationMs: Math.round(performance.now() - startedAt),
        ...qoderRequestId(response.headers) === undefined ? {} : { requestId: qoderRequestId(response.headers) },
      })
      const text = await readLimitedText(
        response,
        response.ok ? defaultMaxJsonBytes : defaultMaxErrorBytes,
        'Qoder identity lookup response',
      )
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
