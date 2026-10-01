/** PAT exchange and in-memory Qoder job-token lifecycle. */

import type { CosyCredentials } from './wire/cosy.ts'
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
    this.region = options.region ?? 'global'
    this.resolveMachineId = options.resolveMachineId ?? (() => getMachineId(qoderMachineIdPaths(this.region)))
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

    const userInfo = await retryMetadataRead(signal, () => this.fetchUserInfo(jobToken, signal))
    const creds: CosyCredentials = {
      userID: userInfo.userID,
      authToken: jobToken,
      name: userInfo.name || 'Qoder User',
      email: userInfo.email,
      machineID,
      ...userInfo.organizationId === undefined ? {} : { organizationId: userInfo.organizationId },
      ...userInfo.organizationTags === undefined ? {} : { organizationTags: userInfo.organizationTags },
      ...userInfo.dataPolicyAgreed === undefined ? {} : { dataPolicyAgreed: userInfo.dataPolicyAgreed },
    }
    const cacheKey = `${this.region}:${opaqueCredentialKey(pat)}`
    this.cache.set(cacheKey, { creds, expiresAt })
    return creds
  }

  private async fetchUserInfo(
    jobToken: string,
    signal: AbortSignal,
  ): Promise<Omit<CosyCredentials, 'authToken' | 'machineID'>> {
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
    let organizationTags = Array.isArray(info.organization_tags)
      ? info.organization_tags.filter(tag => typeof tag === 'string')
      : undefined
    if (organizationId && organizationTags === undefined) {
      try {
        const { tags } = await retryMetadataRead(signal, () => openApiJsonRequest<{ tags?: unknown }>(this.fetchImpl, {
          url: `${resolveQoderEndpoints(this.region).openApiUrl}/api/v1/organizations/${encodeURIComponent(organizationId)}/tags`,
          token: jobToken,
          signal,
          timeoutMs: this.timeoutMs,
          logger: this.logger,
          operation: 'OrganizationTags',
        }))
        organizationTags = Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === 'string') : []
      } catch (error) {
        if (signal.aborted) throw error
        this.logger?.warn?.('[Qoder Auth] Organization tags unavailable; retaining subscriber organization.')
      }
    }
    return {
      userID,
      email: info.email ?? '',
      name: info.name ?? info.username ?? '',
      ...organizationId ? { organizationId } : {},
      ...organizationTags === undefined ? {} : { organizationTags },
      ...typeof info.data_policy_agreed === 'boolean' ? { dataPolicyAgreed: info.data_policy_agreed } : {},
    }
  }
}
