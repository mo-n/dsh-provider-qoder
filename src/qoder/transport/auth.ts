/** PAT exchange and in-memory Qoder job-token lifecycle. */

import type { QoderCredentials } from './wire/credentials.ts'
import { getQoderExchangeUrl, getQoderUserInfoUrl, resolveQoderEndpoints, type QoderRegion } from './endpoints.ts'
import { QoderLlmError } from '../errors.ts'
import type { QoderLogger } from './logging.ts'
import { getMachineId, qoderMachineIdPaths } from './machine-id.ts'
import {
  opaqueCredentialKey,
  openApiJsonRequest,
  retryMetadataRead,
} from './request.ts'

const expiryBufferMs = 5 * 60 * 1000
const defaultExpiryMs = 24 * 60 * 60 * 1000
const defaultAuthTimeoutMs = 15_000
const defaultOrganizationTagsTimeoutMs = 3_000

interface QoderTokenExchange {
  token?: string
  device_token?: string
  access_token?: string
  expires_at?: string | number
  expiresAt?: string | number
  expire_time?: number
  expireTime?: number
  expires_in?: number
}

/** Match qodercli's seconds/milliseconds compatibility, preferring absolute expiry. */
export function jobTokenExpiry(data: QoderTokenExchange, now = Date.now()): number {
  const absolute = data.expires_at ?? data.expiresAt ?? data.expire_time ?? data.expireTime
  if (absolute !== undefined) {
    const parsed = typeof absolute === 'string' ? Date.parse(absolute)
      : absolute > 1e12 ? absolute : absolute * 1000
    if (Number.isFinite(parsed)) return parsed
  }
  const relative = data.expires_in
  if (typeof relative === 'number' && Number.isFinite(relative) && relative > 0) {
    return now + (relative > 86400 ? relative : relative * 1000)
  }
  return now + defaultExpiryMs
}

interface CachedEntry {
  creds: QoderCredentialSnapshot
  expiresAt: number
  issuedAt: number
}

interface InFlightEntry {
  promise: Promise<QoderCredentialSnapshot>
  controller: AbortController
  waiters: number
  settled: boolean
  timeout: ReturnType<typeof setTimeout>
}

export interface QoderCredentialSnapshot extends QoderCredentials {
  readonly expiresAt: number
  readonly version: number
}

export interface QoderAuthServiceOptions {
  fetch?: typeof fetch
  timeoutMs?: number
  /** Independent budget for optional organization metadata, including retries. */
  organizationTagsTimeoutMs?: number
  resolveMachineId?: () => string
  region?: QoderRegion
  logger?: QoderLogger
}

function abortedError(): QoderLlmError {
  return new QoderLlmError('Qoder authentication was aborted.', 'ABORTED')
}

async function waitForFlight(
  promise: Promise<QoderCredentialSnapshot>,
  signal?: AbortSignal,
): Promise<QoderCredentialSnapshot> {
  if (signal === undefined) return promise
  return new Promise<QoderCredentialSnapshot>((resolve, reject) => {
    const onAbort = (): void => reject(abortedError())
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
    // Cancellation can occur while starting the shared exchange. Observe its
    // rejection even when this caller has already aborted.
    if (signal.aborted) onAbort()
  })
}

export class QoderAuthManager {
  private readonly cache = new Map<string, CachedEntry>()
  private readonly inFlight = new Map<string, InFlightEntry>()
  private readonly epochs = new Map<string, number>()
  private nextVersion = 0
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly organizationTagsTimeoutMs: number
  private readonly resolveMachineId: () => string
  private readonly region: QoderRegion
  private readonly logger?: QoderLogger

  constructor(options: QoderAuthServiceOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.timeoutMs = options.timeoutMs ?? defaultAuthTimeoutMs
    this.organizationTagsTimeoutMs = options.organizationTagsTimeoutMs ?? defaultOrganizationTagsTimeoutMs
    this.region = options.region ?? 'global'
    this.resolveMachineId = options.resolveMachineId ?? (() => getMachineId(qoderMachineIdPaths(this.region)))
    this.logger = options.logger
  }

  clear(pat?: string): void {
    if (pat) {
      this.invalidate(`${this.region}:${opaqueCredentialKey(pat)}`)
    } else {
      for (const key of new Set([...this.cache.keys(), ...this.inFlight.keys()])) this.invalidate(key)
    }
  }

  private invalidate(key: string): void {
    this.epochs.set(key, (this.epochs.get(key) ?? 0) + 1)
    this.cache.delete(key)
    const flight = this.inFlight.get(key)
    if (flight) {
      this.inFlight.delete(key)
      flight.controller.abort('credential invalidated')
    }
  }

  /** Recover a rejected credential once; concurrent rejections share the exchange. */
  async refreshCredentials(pat: string, rejected: QoderCredentials, signal?: AbortSignal): Promise<QoderCredentialSnapshot> {
    if (signal?.aborted) throw abortedError()
    const key = `${this.region}:${opaqueCredentialKey(pat)}`
    const current = this.cache.get(key)?.creds
    if (current && current !== rejected) return current
    // A shared proactive refresh must never fall back to a rejected snapshot.
    // Keep the exchange alive so concurrent rejections still share its result.
    this.cache.delete(key)
    const flight = this.inFlight.get(key)
    if (flight) return this.getCredentials(pat, signal)
    this.invalidate(key)
    return this.getCredentials(pat, signal)
  }


  async getCredentials(
    pat: string,
    signal?: AbortSignal,
  ): Promise<QoderCredentialSnapshot> {
    if (!pat || typeof pat !== 'string') {
      throw new QoderLlmError(
        'Qoder Personal Access Token is missing or invalid. Configure Qoder in the Qoder settings page.',
        'MISSING_CREDENTIAL',
      )
    }
    if (signal?.aborted) throw abortedError()

    const cacheKey = `${this.region}:${opaqueCredentialKey(pat)}`

    const cached = this.cache.get(cacheKey)
    if (cached) {
      const lifetime = cached.expiresAt - cached.issuedAt
      const buffer = Math.min(expiryBufferMs, Math.max(0, lifetime / 5))
      if (cached.expiresAt > Date.now() + buffer) return cached.creds
    }

    let entry = this.inFlight.get(cacheKey)
    if (entry === undefined || entry.controller.signal.aborted) {
      const controller = new AbortController()
      const created = {} as InFlightEntry
      created.controller = controller
      created.waiters = 0
      created.settled = false
      created.timeout = setTimeout(() => controller.abort('authentication timeout'), this.timeoutMs)
      const epoch = this.epochs.get(cacheKey) ?? 0
      created.promise = this.exchangeAndResolve(pat, controller.signal, () => clearTimeout(created.timeout), epoch).catch(error => {
        const stale = this.cache.get(cacheKey)
        const temporary = error instanceof QoderLlmError
          && (error.code === 'TRANSPORT' || error.code === 'TIMEOUT' || error.code === 'SERVER')
        if (temporary && stale && stale.expiresAt > Date.now()
          && (this.epochs.get(cacheKey) ?? 0) === epoch && !controller.signal.aborted) return stale.creds
        throw error
      }).finally(() => {
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
    onAuthenticated: () => void,
    epoch: number,
  ): Promise<QoderCredentialSnapshot> {
    const machineID = this.resolveMachineId().trim()
    const data = await openApiJsonRequest<QoderTokenExchange>(
      this.fetchImpl,
      {
        url: getQoderExchangeUrl(this.region),
        body: { personal_token: pat, ...machineID && machineID !== 'unknown' ? { machine_id: machineID } : {} },
        signal,
        timeoutMs: this.timeoutMs,
        logger: this.logger,
        operation: 'Auth',
        logCategory: 'auth.exchange',
      },
    )
    const jobToken = [data.token, data.device_token, data.access_token].find(value => typeof value === 'string' && value.length > 0)
    if (!jobToken) {
      throw new QoderLlmError('Qoder PAT exchange returned no job token.', 'AUTH')
    }
    const expiresAt = jobTokenExpiry(data)

    const resolved = await this.credentialsForToken(jobToken, machineID, signal, onAuthenticated)
    const creds: QoderCredentialSnapshot = { ...resolved, expiresAt, version: ++this.nextVersion }
    const cacheKey = `${this.region}:${opaqueCredentialKey(pat)}`
    if ((this.epochs.get(cacheKey) ?? 0) !== epoch || signal.aborted) throw abortedError()
    this.cache.set(cacheKey, { creds, expiresAt, issuedAt: Date.now() })
    return creds
  }

  /** Both PAT exchange and browser authorization use the same verified subscriber identity. */
  async credentialsForToken(jobToken: string, machineID: string, signal: AbortSignal, onAuthenticated = () => {}): Promise<QoderCredentials> {
    const userInfo = await retryMetadataRead(signal, () => this.fetchUserInfo(jobToken, signal))
    if (signal.aborted) throw abortedError()
    // The authentication deadline protects the required exchange and identity
    // lookup only. Optional tags have their own budget and share caller cancellation.
    onAuthenticated()
    const creds: QoderCredentials = {
      userID: userInfo.userID,
      authToken: jobToken,
      name: userInfo.name || 'Qoder User',
      email: userInfo.email,
      machineID,
      ...userInfo.organizationId === undefined ? {} : { organizationId: userInfo.organizationId },
      ...userInfo.organizationTags === undefined ? {} : { organizationTags: userInfo.organizationTags },
      ...userInfo.dataPolicyAgreed === undefined ? {} : { dataPolicyAgreed: userInfo.dataPolicyAgreed },
    }
    if (creds.organizationId && creds.organizationTags === undefined) {
      const tags = await this.fetchOrganizationTags(jobToken, creds.organizationId, signal)
      if (tags !== undefined) creds.organizationTags = tags
    }
    if (signal.aborted) throw abortedError()
    return creds
  }

  private async fetchUserInfo(
    jobToken: string,
    signal: AbortSignal,
  ): Promise<Omit<QoderCredentials, 'authToken' | 'machineID'>> {
    const info = await openApiJsonRequest<{
      id?: string
      user_id?: string
      uid?: string
      email?: string
      name?: string
      username?: string
      organization_id?: string
      organizationId?: string
      orgId?: string
      organization?: { org_id?: string; orgId?: string; id?: string }
      organization_tags?: string[]
      data_policy_agreed?: boolean
    }>(this.fetchImpl, {
      url: getQoderUserInfoUrl(this.region),
      token: jobToken,
      signal,
      timeoutMs: this.timeoutMs,
      logger: this.logger,
      operation: 'UserInfo',
      logCategory: 'auth.user-info',
    })
    const userID = [info.id, info.user_id, info.uid].find(value => typeof value === 'string' && value.length > 0)
    const organizationId = [info.orgId, info.organization_id, info.organizationId,
      info.organization?.org_id, info.organization?.orgId, info.organization?.id]
      .find(value => typeof value === 'string' && value.length > 0)
    if (!userID) {
      throw new QoderLlmError('Qoder identity lookup returned no user id.', 'AUTH')
    }
    const organizationTags = Array.isArray(info.organization_tags)
      ? info.organization_tags.filter(tag => typeof tag === 'string')
      : undefined
    return {
      userID,
      email: info.email ?? '',
      name: info.name ?? info.username ?? '',
      ...organizationId ? { organizationId } : {},
      ...organizationTags === undefined ? {} : { organizationTags },
      ...typeof info.data_policy_agreed === 'boolean' ? { dataPolicyAgreed: info.data_policy_agreed } : {},
    }
  }

  private async fetchOrganizationTags(
    jobToken: string,
    organizationId: string,
    signal: AbortSignal,
  ): Promise<string[] | undefined> {
    const timeout = AbortSignal.timeout(this.organizationTagsTimeoutMs)
    const lookupSignal = AbortSignal.any([signal, timeout])
    try {
      const { tags } = await retryMetadataRead(lookupSignal, () => openApiJsonRequest<{ tags?: unknown }>(this.fetchImpl, {
        url: `${resolveQoderEndpoints(this.region).openApiUrl}/api/v1/organizations/${encodeURIComponent(organizationId)}/tags`,
        token: jobToken,
        signal: lookupSignal,
        timeoutMs: this.organizationTagsTimeoutMs,
        logger: this.logger,
        operation: 'OrganizationTags',
      }))
      return Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === 'string') : []
    } catch (error) {
      if (signal.aborted) throw error
      this.logger?.warn?.('[Qoder Auth] Organization tags unavailable; retaining subscriber organization.')
      return undefined
    }
  }
}

/** Retained for callers of the existing internal transport module. */
export { QoderAuthManager as QoderAuthService }
