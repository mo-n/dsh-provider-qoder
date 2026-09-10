/** Qoder subscriber profile and quota usage querying. */

import type { QoderAuthService } from './auth.ts'
import {
  getQoderUsageUrl,
  getQoderUserPlanUrl,
  getQoderUserStatusUrl,
  type QoderRegion,
} from './endpoints.ts'
import type {
  QoderAccountInfo,
  QoderQuota,
  QoderQuotaUsage,
  QoderSubscriberFeatureAllowed,
  QoderSubscriberOrganization,
  QoderSubscriberPlan,
  QoderSubscriberProfile,
  QoderSubscriberStatus,
} from '../account.ts'
import { QoderLlmError, qoderHttpError, qoderRequestId } from '../errors.ts'
import {
  logParsedResponse,
  redactLogPayload,
  type QoderLogger,
} from './logging.ts'
import {
  defaultMaxErrorBytes,
  defaultMaxJsonBytes,
  opaqueCredentialKey,
  readLimitedText,
  retryMetadataRead,
  SingleFlight,
} from './request.ts'

const userAgent = 'dsh-provider-qoder'
const defaultUsageTtlMs = 60_000
const defaultUsageTimeoutMs = 15_000

export interface QoderUsageReaderOptions {
  authService: QoderAuthService
  fetch?: typeof fetch
  ttlMs?: number
  timeoutMs?: number
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

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim().length > 0) {
    const num = Number(value)
    if (Number.isFinite(num)) return num
  }
  return undefined
}

function normalizeOrganization(raw: unknown): QoderSubscriberOrganization | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const obj = raw as Record<string, unknown>
  const orgId = asString(obj.org_id) ?? asString(obj.orgId) ?? asString(obj.id)
  const orgName = asString(obj.org_name) ?? asString(obj.orgName) ?? asString(obj.name)
  if (!orgId || !orgName) return undefined
  return {
    orgId,
    orgName,
    ...asString(obj.role_name) ?? asString(obj.roleName) !== undefined
      ? { roleName: asString(obj.role_name) ?? asString(obj.roleName) }
      : {},
    isSuspended: asBoolean(obj.is_suspended) ?? asBoolean(obj.isSuspended) ?? false,
    canManageSubscriptions: asBoolean(obj.can_manage_subscriptions) ?? asBoolean(obj.canManageSubscriptions) ?? false,
    resourcePackageFeatureEnabled: asBoolean(obj.resource_package_feature_enabled) ?? asBoolean(obj.resourcePackageFeatureEnabled) ?? false,
  }
}

function normalizeFeatureAllowed(raw: unknown): QoderSubscriberFeatureAllowed | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const obj = raw as Record<string, unknown>
  return {
    quest: asBoolean(obj.quest) ?? false,
    wiki: asBoolean(obj.wiki) ?? false,
    codeReview: asBoolean(obj.code_review) ?? asBoolean(obj.codeReview) ?? false,
  }
}

function normalizePlan(raw: unknown): QoderSubscriberPlan | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const obj = raw as Record<string, unknown>
  const userType = asString(obj.user_type) ?? asString(obj.userType)
  const planTierName = asString(obj.plan_tier_name) ?? asString(obj.planTierName) ?? asString(obj.plan_name) ?? asString(obj.planName)
  if (!userType || !planTierName) return undefined

  const organization = normalizeOrganization(obj.organization)
  const isPersonalVersion = asBoolean(obj.is_personal_version) ?? asBoolean(obj.isPersonalVersion) ?? (organization === undefined)
  const startDate = normalizeExpiresAt(obj.start_date as number | string ?? obj.startDate as number | string)
  const endDate = normalizeExpiresAt(obj.end_date as number | string ?? obj.endDate as number | string)
  const planTier = asString(obj.plan_tier) ?? asString(obj.planTier)
  const isHighestTier = asBoolean(obj.is_highest_tier) ?? asBoolean(obj.isHighestTier)
  const isRenewed = asBoolean(obj.is_renewed) ?? asBoolean(obj.isRenewed)
  const featureAllowed = normalizeFeatureAllowed(obj.feature_allowed ?? obj.featureAllowed)

  return {
    userType,
    planTierName,
    ...planTier !== undefined ? { planTier } : {},
    isPersonalVersion,
    ...isHighestTier !== undefined ? { isHighestTier } : {},
    ...isRenewed !== undefined ? { isRenewed } : {},
    ...startDate !== undefined ? { startDate } : {},
    ...endDate !== undefined ? { endDate } : {},
    ...organization !== undefined ? { organization } : {},
    ...featureAllowed !== undefined ? { featureAllowed } : {},
    raw,
  }
}

function normalizeStatus(raw: unknown): QoderSubscriberStatus | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const obj = raw as Record<string, unknown>
  const featureSwitches = (obj.featureSwitches ?? obj.feature_switches) as Record<string, unknown> | undefined
  const teamSwitches = (obj.teamSwitches ?? obj.team_switches) as Record<string, unknown> | undefined
  const allowByok = asNumber(featureSwitches?.allow_byok ?? featureSwitches?.allowByok) ?? 0
  const teamAllowByok = asNumber(teamSwitches?.allow_byok ?? teamSwitches?.allowByok)
  const isPrivacyPolicyModifiable = asBoolean(obj.isPrivacyPolicyModifiable ?? obj.is_data_policy_modifiable)

  return {
    allowByok,
    ...teamAllowByok !== undefined ? { teamAllowByok } : {},
    ...isPrivacyPolicyModifiable !== undefined ? { isPrivacyPolicyModifiable } : {},
    raw,
  }
}

export class QoderUsageReader {
  private readonly authService: QoderAuthService
  private readonly fetchImpl: typeof fetch
  private readonly ttlMs: number
  private readonly timeoutMs: number
  private readonly region: QoderRegion
  private readonly logger?: QoderLogger
  private readonly cache = new Map<string, { info: QoderAccountInfo; expiresAt: number }>()
  private readonly flights = new SingleFlight<QoderAccountInfo>()

  constructor(options: QoderUsageReaderOptions) {
    this.authService = options.authService
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.ttlMs = options.ttlMs ?? defaultUsageTtlMs
    this.timeoutMs = options.timeoutMs ?? defaultUsageTimeoutMs
    this.region = options.region ?? 'global'
    this.logger = options.logger
  }

  async readAccount(
    pat: string,
    options?: { force?: boolean; signal?: AbortSignal },
  ): Promise<QoderAccountInfo> {
    if (!pat || typeof pat !== 'string') {
      throw new QoderLlmError(
        'Qoder Personal Access Token is missing or invalid.',
        'MISSING_CREDENTIAL',
      )
    }

    const cacheKey = `${this.region}:${opaqueCredentialKey(pat)}`

    if (!options?.force) {
      const cached = this.cache.get(cacheKey)
      if (cached && cached.expiresAt > Date.now()) {
        return cached.info
      }
    }

    return this.flights.run(
      cacheKey,
      options?.signal,
      sharedSignal => this.loadAccount(pat, sharedSignal, cacheKey),
      () => new QoderLlmError('Qoder account request was aborted.', 'ABORTED'),
    )
  }

  private async loadAccount(
    pat: string,
    signal: AbortSignal,
    cacheKey: string,
  ): Promise<QoderAccountInfo> {
    const creds = await this.authService.getCredentials(pat, signal)
    const profile: QoderSubscriberProfile = {
      id: creds.userID,
      name: creds.name || 'Qoder User',
      email: creds.email || '',
    }

    const [usage, plan, status] = await Promise.all([
      retryMetadataRead(signal, () => this.fetchUsage(creds.authToken, signal)),
      this.safeFetchPlan(creds.authToken, signal),
      this.safeFetchStatus(creds.authToken, creds.machineID, signal),
    ])

    const accountInfo: QoderAccountInfo = {
      profile,
      usage,
      ...plan !== undefined ? { plan } : {},
      ...status !== undefined ? { status } : {},
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
      this.cache.delete(`${this.region}:${opaqueCredentialKey(pat)}`)
    } else {
      this.cache.clear()
    }
  }

  private async fetchUsage(jobToken: string, signal?: AbortSignal): Promise<QoderQuotaUsage> {
    const url = getQoderUsageUrl(this.region)
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs)
    const requestSignal = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal])
    const startedAt = performance.now()
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
        durationMs: Math.round(performance.now() - startedAt),
        ...qoderRequestId(response.headers) === undefined ? {} : { requestId: qoderRequestId(response.headers) },
      })
      const text = await readLimitedText(
        response,
        response.ok ? defaultMaxJsonBytes : defaultMaxErrorBytes,
        'Qoder quota usage response',
      )

      if (!response.ok) {
        this.logger?.error?.('[Qoder Usage] Request failed', redactLogPayload(text))
        throw qoderHttpError(
          `Failed to fetch Qoder quota usage with status ${response.status}.`,
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
      logParsedResponse(this.logger, 'account.usage', data)

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

  private async fetchPlan(jobToken: string, signal?: AbortSignal): Promise<QoderSubscriberPlan | undefined> {
    const url = getQoderUserPlanUrl(this.region)
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs)
    const requestSignal = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal])
    const startedAt = performance.now()
    this.logger?.debug?.('[Qoder Plan] Requesting user plan', { url })
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
      this.logger?.debug?.('[Qoder Plan] Request completed', {
        status: response.status,
        statusText: response.statusText,
        durationMs: Math.round(performance.now() - startedAt),
        ...qoderRequestId(response.headers) === undefined ? {} : { requestId: qoderRequestId(response.headers) },
      })
      const text = await readLimitedText(
        response,
        response.ok ? defaultMaxJsonBytes : defaultMaxErrorBytes,
        'Qoder user plan response',
      )
      if (!response.ok) {
        this.logger?.error?.('[Qoder Plan] Request failed', redactLogPayload(text))
        throw qoderHttpError(`Failed to fetch Qoder user plan with status ${response.status}.`, response)
      }
      let data: unknown
      try {
        data = JSON.parse(text)
      } catch {
        this.logger?.error?.('[Qoder Plan] Invalid JSON response', redactLogPayload(text))
        throw new QoderLlmError('Failed to parse Qoder user plan JSON response', 'PLAN_FETCH_FAILED')
      }
      logParsedResponse(this.logger, 'account.plan', data)
      return normalizePlan(data)
    } catch (error: unknown) {
      if (error instanceof QoderLlmError) throw error
      if (signal?.aborted) {
        throw new QoderLlmError('Qoder user plan request was aborted.', 'ABORTED')
      }
      if (timeoutSignal.aborted) {
        throw new QoderLlmError('Qoder user plan request timed out.', 'TIMEOUT')
      }
      throw new QoderLlmError('Qoder user plan network request failed.', 'TRANSPORT', { cause: error })
    }
  }

  private async safeFetchPlan(jobToken: string, signal: AbortSignal): Promise<QoderSubscriberPlan | undefined> {
    try {
      return await this.fetchPlan(jobToken, signal)
    } catch (error) {
      if (signal.aborted) throw error
      this.logger?.warn?.('[Qoder Plan] Failed to load user plan (degraded)', error instanceof Error ? error.message : error)
      return undefined
    }
  }

  private async fetchStatus(
    jobToken: string,
    machineId?: string,
    signal?: AbortSignal,
  ): Promise<QoderSubscriberStatus | undefined> {
    const url = getQoderUserStatusUrl(this.region)
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs)
    const requestSignal = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal])
    const startedAt = performance.now()
    this.logger?.debug?.('[Qoder Status] Requesting user status', { url })
    try {
      const headers: Record<string, string> = {
        authorization: `Bearer ${jobToken}`,
        accept: 'application/json',
        'user-agent': userAgent,
        'cosy-version': '1.0.1',
        'cosy-clienttype': '5',
      }
      if (machineId) {
        headers['Cosy-MachineToken'] = machineId
        headers['Cosy-MachineType'] = 'host'
      }
      const response = await this.fetchImpl(url, {
        method: 'GET',
        headers,
        signal: requestSignal,
      })
      this.logger?.debug?.('[Qoder Status] Request completed', {
        status: response.status,
        statusText: response.statusText,
        durationMs: Math.round(performance.now() - startedAt),
        ...qoderRequestId(response.headers) === undefined ? {} : { requestId: qoderRequestId(response.headers) },
      })
      const text = await readLimitedText(
        response,
        response.ok ? defaultMaxJsonBytes : defaultMaxErrorBytes,
        'Qoder user status response',
      )
      if (!response.ok) {
        this.logger?.error?.('[Qoder Status] Request failed', redactLogPayload(text))
        throw qoderHttpError(`Failed to fetch Qoder user status with status ${response.status}.`, response)
      }
      let data: unknown
      try {
        data = JSON.parse(text)
      } catch {
        this.logger?.error?.('[Qoder Status] Invalid JSON response', redactLogPayload(text))
        throw new QoderLlmError('Failed to parse Qoder user status JSON response', 'STATUS_FETCH_FAILED')
      }
      logParsedResponse(this.logger, 'account.status', data)
      return normalizeStatus(data)
    } catch (error: unknown) {
      if (error instanceof QoderLlmError) throw error
      if (signal?.aborted) {
        throw new QoderLlmError('Qoder user status request was aborted.', 'ABORTED')
      }
      if (timeoutSignal.aborted) {
        throw new QoderLlmError('Qoder user status request timed out.', 'TIMEOUT')
      }
      throw new QoderLlmError('Qoder user status network request failed.', 'TRANSPORT', { cause: error })
    }
  }

  private async safeFetchStatus(
    jobToken: string,
    machineId?: string,
    signal?: AbortSignal,
  ): Promise<QoderSubscriberStatus | undefined> {
    try {
      return await this.fetchStatus(jobToken, machineId, signal)
    } catch (error) {
      if (signal?.aborted) throw error
      this.logger?.warn?.('[Qoder Status] Failed to load user status (degraded)', error instanceof Error ? error.message : error)
      return undefined
    }
  }
}
