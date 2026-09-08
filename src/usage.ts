/** Qoder subscriber profile and quota usage querying. */

import type { QoderAuthService } from './auth.ts'
import { getQoderUsageUrl, type QoderRegion } from './endpoints.ts'
import { QoderLlmError, qoderHttpError } from './errors.ts'
import { redactLogPayload, redactLogValue, type QoderLogger } from './logging.ts'

const userAgent = 'dsh-provider-qoder'
const defaultUsageTtlMs = 60_000
const defaultUsageTimeoutMs = 15_000

export interface QoderSubscriberProfile {
  id: string
  name: string
  email: string
}

export interface QoderQuota {
  total: number
  used: number
  remaining: number
  percentage: number
  unit: string
}

export interface QoderQuotaUsage {
  userQuota?: QoderQuota
  orgResourcePackage?: QoderQuota
  totalUsagePercentage?: number
  isQuotaExceeded?: boolean
  expiresAt?: string
  raw?: unknown
}

export interface QoderAccountInfo {
  profile: QoderSubscriberProfile
  usage?: QoderQuotaUsage
  updatedAt: string
}

export interface QoderUsageReaderOptions {
  authService: QoderAuthService
  fetch?: typeof fetch
  ttlMs?: number
  timeoutMs?: number
  resolveRegion?: () => QoderRegion
  region?: QoderRegion
  logger?: QoderLogger
}


interface RawQuota {
  total?: number
  cap?: number
  used?: number
  remaining?: number
  percentage?: number
  unit?: string
  available?: boolean
}

interface RawUsageInfo {
  userQuota?: RawQuota
  orgResourcePackage?: RawQuota
  totalUsagePercentage?: number
  isQuotaExceeded?: boolean
  expiresAt?: number | string
  userType?: string
  upgradeUrl?: string
}

function normalizeQuota(raw?: RawQuota): QoderQuota | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const total = typeof raw.total === 'number' && Number.isFinite(raw.total)
    ? raw.total
    : (typeof raw.cap === 'number' && Number.isFinite(raw.cap)
      ? raw.cap
      : (typeof raw.remaining === 'number' && typeof raw.used === 'number'
        ? raw.used + raw.remaining
        : 0))
  const used = typeof raw.used === 'number' && Number.isFinite(raw.used) ? raw.used : 0
  const remaining = typeof raw.remaining === 'number' && Number.isFinite(raw.remaining)
    ? raw.remaining
    : Math.max(0, total - used)

  let percentage: number
  if (typeof raw.percentage === 'number' && Number.isFinite(raw.percentage)) {
    percentage = raw.percentage <= 1 && total > 1 ? raw.percentage * 100 : raw.percentage
  } else {
    percentage = total > 0 ? (used / total) * 100 : 0
  }

  const unit = typeof raw.unit === 'string' && raw.unit.length > 0 ? raw.unit : 'credits'

  return { total, used, remaining, percentage, unit }
}


function normalizeExpiresAt(rawExpires?: number | string): string | undefined {
  if (rawExpires === undefined || rawExpires === null) return undefined
  if (typeof rawExpires === 'number' && rawExpires > 0) {
    return new Date(rawExpires).toISOString()
  }
  if (typeof rawExpires === 'string' && rawExpires.length > 0) {
    const parsed = Date.parse(rawExpires)
    if (!Number.isNaN(parsed) && parsed > 0) return new Date(parsed).toISOString()
  }
  return undefined
}

export class QoderUsageReader {
  private readonly authService: QoderAuthService
  private readonly fetchImpl: typeof fetch
  private readonly ttlMs: number
  private readonly timeoutMs: number
  private readonly resolveRegion?: () => QoderRegion
  private region?: QoderRegion
  private readonly logger?: QoderLogger
  private readonly cache = new Map<string, { info: QoderAccountInfo; expiresAt: number }>()

  constructor(options: QoderUsageReaderOptions) {
    this.authService = options.authService
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.ttlMs = options.ttlMs ?? defaultUsageTtlMs
    this.timeoutMs = options.timeoutMs ?? defaultUsageTimeoutMs
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

  async readAccount(
    pat: string,
    options?: { force?: boolean; signal?: AbortSignal; region?: QoderRegion },
  ): Promise<QoderAccountInfo> {
    if (!pat || typeof pat !== 'string') {
      throw new QoderLlmError(
        'Qoder Personal Access Token is missing or invalid.',
        'MISSING_CREDENTIAL',
      )
    }

    const effectiveRegion = options?.region ?? this.currentRegion()
    const cacheKey = `${effectiveRegion}:${pat}`

    if (!options?.force) {
      const cached = this.cache.get(cacheKey)
      if (cached && cached.expiresAt > Date.now()) {
        return cached.info
      }
    }

    const creds = await this.authService.getCredentials(pat, options?.signal, effectiveRegion)
    const profile: QoderSubscriberProfile = {
      id: creds.userID,
      name: creds.name || 'Qoder User',
      email: creds.email || '',
    }

    const usage = await this.fetchUsage(creds.authToken, options?.signal, effectiveRegion)

    const accountInfo: QoderAccountInfo = {
      profile,
      usage,
      updatedAt: new Date().toISOString(),
    }

    this.cache.set(cacheKey, {
      info: accountInfo,
      expiresAt: Date.now() + this.ttlMs,
    })

    return accountInfo
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

  private async fetchUsage(jobToken: string, signal?: AbortSignal, region?: QoderRegion): Promise<QoderQuotaUsage> {
    const effectiveRegion = region ?? this.currentRegion()
    const url = getQoderUsageUrl(effectiveRegion)
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs)
    const requestSignal = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal])
    this.logger?.debug?.('[Qoder Usage] Requesting quota usage', { url })
    try {
      const response = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${jobToken}`,
          accept: 'application/json',
          'user-agent': userAgent,
          'cosy-version': '1.0.1',
          'cosy-clienttype': '5',
        },
        signal: requestSignal,
      })

      this.logger?.debug?.('[Qoder Usage] Request completed', {
        status: response.status,
        statusText: response.statusText,
      })
      const text = await response.text()

      if (!response.ok) {
        this.logger?.error?.('[Qoder Usage] Request failed', redactLogPayload(text))
        throw qoderHttpError(
          `Failed to fetch Qoder quota usage with status ${response.status}: ${text}`,
          response,
        )
      }

      let data: RawUsageInfo
      try {
        data = JSON.parse(text) as RawUsageInfo
      } catch {
        this.logger?.error?.('[Qoder Usage] Invalid JSON response', redactLogPayload(text))
        throw new QoderLlmError('Failed to parse Qoder quota JSON response', 'USAGE_FETCH_FAILED')
      }
      this.logger?.debug?.('[Qoder Usage] Quota usage resolved', redactLogValue(data))

      return {
        userQuota: normalizeQuota(data.userQuota),
        orgResourcePackage: normalizeQuota(data.orgResourcePackage),
        totalUsagePercentage: typeof data.totalUsagePercentage === 'number' ? data.totalUsagePercentage : undefined,
        isQuotaExceeded: typeof data.isQuotaExceeded === 'boolean' ? data.isQuotaExceeded : false,
        expiresAt: normalizeExpiresAt(data.expiresAt),
        raw: data,
      }
    } catch (error: unknown) {
      if (error instanceof QoderLlmError) throw error
      if (signal?.aborted) {
        throw new QoderLlmError('Qoder quota usage request was aborted.', 'ABORTED')
      }
      if (timeoutSignal.aborted) {
        throw new QoderLlmError('Qoder quota usage request timed out.', 'TIMEOUT')
      }
      throw new QoderLlmError('Qoder quota usage network request failed.', 'TRANSPORT', { cause: error })
    }
  }
}
