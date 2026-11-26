/** Qoder subscriber profile and quota usage querying. */

import type { QoderAuthService } from './auth.ts'
import { normalizeMachineIdentity, type QoderCredentials } from './wire/credentials.ts'
import type { QoderMachineIdentity } from './umid-cache.ts'
import {
  getQoderUsageUrl,
  getQoderUserPlanUrl,
  getQoderUserStatusUrl,
  type QoderRegion,
} from './endpoints.ts'
import type {
  QoderAccountInfo,
  QoderLocalizedText,
  QoderQuota,
  QoderQuotaUsage,
  QoderResourcePackage,
  QoderSubscriberFeatureAllowed,
  QoderSubscriberOrganization,
  QoderSubscriberPlan,
  QoderSubscriberProfile,
  QoderSubscriberStatus,
} from '../account.ts'
import { QoderLlmError } from '../errors.ts'
import { redactLogValue, type QoderLogger } from './logging.ts'
import {
  opaqueCredentialKey,
  openApiJsonRequest,
  retryMetadataRead,
  SingleFlight,
} from './request.ts'

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


function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function normalizePercentage(value: unknown): number | undefined {
  const percentage = finiteNumber(value)
  if (percentage === undefined) return undefined
  return percentage >= 0 && percentage <= 1 ? percentage * 100 : percentage
}

function normalizeQuota(raw: unknown, preferCap = false): QoderQuota | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const obj = raw as Record<string, unknown>
  const reportedTotal = finiteNumber(obj.total)
  const cap = finiteNumber(obj.cap)
  const used = finiteNumber(obj.used)
  const reportedRemaining = finiteNumber(obj.remaining)
  const total = (preferCap ? cap ?? reportedTotal : reportedTotal ?? cap)
    ?? (used !== undefined && reportedRemaining !== undefined ? finiteNumber(used + reportedRemaining) : undefined)
  const remaining = reportedRemaining
    ?? (total !== undefined && used !== undefined ? finiteNumber(Math.max(0, total - used)) : undefined)
  const reportedPercentage = normalizePercentage(obj.percentage)
  const percentage = reportedPercentage === undefined
    ? (total !== undefined && total > 0 && used !== undefined ? finiteNumber(used / total * 100) : undefined)
    : Number(reportedPercentage.toFixed(2))
  const available = asBoolean(obj.available)
  return { total, used, remaining, percentage, unit: asString(obj.unit) ?? 'credits', available }
}


/**
 * Normalize an epoch-millis (or parseable date string) expiry to ISO-8601.
 *
 * The provider uses the int64 maximum as a "never expires" sentinel, which is
 * outside the `Date` range: an unusable value resolves to `undefined` instead
 * of throwing, so one bad field cannot abort the whole account read.
 */
function normalizeExpiresAt(rawExpires: unknown): string | undefined {
  if (rawExpires === undefined || rawExpires === null) return undefined
  const parsed = typeof rawExpires === 'number'
    ? rawExpires
    : (typeof rawExpires === 'string' && rawExpires.length > 0 ? Date.parse(rawExpires) : Number.NaN)
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined
  const date = new Date(parsed)
  if (!Number.isFinite(date.getTime())) return undefined
  return date.toISOString()
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

/**
 * Subscriber-facing copy comes from `displayLabels`. Package names can be
 * internal campaign identifiers.
 */
function findDisplayLabel(raw: unknown, dimension: string): unknown {
  if (!Array.isArray(raw)) return undefined
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const obj = entry as Record<string, unknown>
    if (asString(obj.dimension) === dimension) return obj
  }
  return undefined
}

/**
 * Normalize one `displayLabels` entry into language-tagged copy.
 *
 * The provider's value lives under `valueI18n`/`value_i18n`, keyed by language
 * tag, plus `value` as the untagged fallback. An entry with neither is dropped
 * rather than surfaced as an empty label.
 */
function normalizeLocalizedText(raw: unknown): QoderLocalizedText | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const obj = raw as Record<string, unknown>
  const values: Record<string, string> = {}
  const localized = obj.valueI18n ?? obj.value_i18n
  if (localized && typeof localized === 'object') {
    for (const [locale, text] of Object.entries(localized as Record<string, unknown>)) {
      const resolved = asString(text)
      if (resolved !== undefined) values[locale] = resolved
    }
  }
  const fallback = asString(obj.value)
  if (fallback === undefined && Object.keys(values).length === 0) return undefined
  return { values, fallback: fallback ?? '' }
}

function resourceModelScope(labels: unknown): Pick<QoderResourcePackage, 'modelFamilies' | 'modelKeys'> {
  if (!Array.isArray(labels)) return {}
  const modelFamilies = new Set<string>()
  const modelKeys = new Set<string>()
  for (const label of labels) {
    if (!label || typeof label !== 'object') continue
    const value = asString(label.value)
    if (value === undefined) continue
    if (label.dimension === 'model_family') modelFamilies.add(value)
    if (label.dimension === 'model_key') modelKeys.add(value)
  }
  return {
    ...modelFamilies.size > 0 ? { modelFamilies: [...modelFamilies] } : {},
    ...modelKeys.size > 0 ? { modelKeys: [...modelKeys] } : {},
  }
}

/**
 * Normalize the dedicated (entitlement-scoped) resource packages.
 *
 * Copy is read from `displayLabels` only, never from `name`/`description`,
 * which can carry internal campaign identifiers.
 */
function normalizeResourcePackages(raw: unknown): QoderResourcePackage[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const packages: QoderResourcePackage[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const obj = entry as Record<string, unknown>
    const quota = normalizeQuota(obj)
    const status = asString(obj.status)
    if (quota === undefined) continue
    const id = asString(obj.id)
    const labels = obj.display_labels ?? obj.displayLabels
    const title = normalizeLocalizedText(findDisplayLabel(labels, 'title'))
    const description = normalizeLocalizedText(findDisplayLabel(labels, 'description'))
    const expiresAt = normalizeExpiresAt(obj.expires_at) ?? normalizeExpiresAt(obj.expiresAt)
    const modelScope = resourceModelScope(labels)
    if (quota.total === undefined && quota.used === undefined && quota.remaining === undefined
      && quota.available === undefined && status === undefined && title === undefined
      && description === undefined && expiresAt === undefined
      && modelScope.modelFamilies === undefined && modelScope.modelKeys === undefined) continue
    packages.push({
      ...id !== undefined ? { id } : {},
      ...title !== undefined ? { title } : {},
      ...description !== undefined ? { description } : {},
      ...quota,
      ...expiresAt !== undefined ? { expiresAt } : {},
      ...status !== undefined ? { status } : {},
      ...modelScope,
    })
  }
  return packages.length > 0 ? packages : undefined
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

    return this.readWithCredentials(opaqueCredentialKey(pat), signal => this.authService.getCredentials(pat, signal), options)
  }

  async readWithCredentials(
    key: string,
    resolve: (signal?: AbortSignal) => Promise<QoderCredentials>,
    options?: { force?: boolean; signal?: AbortSignal; refresh?: (rejected: QoderCredentials, signal: AbortSignal) => Promise<QoderCredentials> },
  ): Promise<QoderAccountInfo> {
    const cacheKey = `${this.region}:${key}`

    if (!options?.force) {
      const cached = this.cache.get(cacheKey)
      if (cached && cached.expiresAt > Date.now()) {
        return cached.info
      }
    }

    return this.flights.run(
      cacheKey,
      options?.signal,
      async sharedSignal => {
        let credentials: QoderCredentials | undefined
        try {
          return await this.loadAccount(async signal => {
            credentials = await resolve(signal)
            return credentials
          }, sharedSignal, cacheKey)
        } catch (error) {
          if (!(error instanceof QoderLlmError) || error.code !== 'AUTH' || !credentials || !options?.refresh) throw error
          const refreshed = await options.refresh(credentials, sharedSignal)
          return this.loadAccount(async () => refreshed, sharedSignal, cacheKey)
        }
      },
      () => new QoderLlmError('Qoder account request was aborted.', 'ABORTED'),
    )
  }

  private async loadAccount(
    resolve: (signal?: AbortSignal) => Promise<QoderCredentials>,
    signal: AbortSignal,
    cacheKey: string,
  ): Promise<QoderAccountInfo> {
    const creds = await resolve(signal)
    const profile: QoderSubscriberProfile = {
      id: creds.userID,
      name: creds.name || 'Qoder User',
      email: creds.email || '',
    }

    const [usage, plan, status] = await Promise.all([
      retryMetadataRead(signal, () => this.fetchUsage(creds.authToken, signal)),
      this.safeFetchPlan(creds.authToken, signal),
      this.safeFetchStatus(creds.authToken, signal, creds),
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
    const raw = await openApiJsonRequest<unknown>(this.fetchImpl, {
      url: getQoderUsageUrl(this.region),
      token: jobToken,
      signal,
      timeoutMs: this.timeoutMs,
      logger: this.logger,
      operation: 'Usage',
      logCategory: 'account.usage',
    })

    const data = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
    const dedicatedResourcePackages = normalizeResourcePackages(
      data.dedicated_resource_packages ?? data.dedicatedResourcePackages,
    )
    const totalUsagePercentage = normalizePercentage(data.total_usage_percentage)
      ?? normalizePercentage(data.totalUsagePercentage)
    const isQuotaExceeded = asBoolean(data.is_quota_exceeded) ?? asBoolean(data.isQuotaExceeded)

    return {
      userQuota: normalizeQuota(data.user_quota ?? data.userQuota),
      orgResourcePackage: normalizeQuota(
        data.org_resource_package ?? data.orgResourcePackage ?? data.shared_quota ?? data.sharedQuota,
        true,
      ),
      addOnQuota: normalizeQuota(data.add_on_quota ?? data.addOnQuota),
      ...dedicatedResourcePackages !== undefined ? { dedicatedResourcePackages } : {},
      totalUsagePercentage: totalUsagePercentage === undefined ? undefined : Number(totalUsagePercentage.toFixed(2)),
      isQuotaExceeded: isQuotaExceeded ?? (totalUsagePercentage === undefined ? undefined : totalUsagePercentage >= 100),
      expiresAt: normalizeExpiresAt(data.expires_at) ?? normalizeExpiresAt(data.expiresAt),
      raw,
    }
  }

  private async fetchPlan(jobToken: string, signal?: AbortSignal): Promise<QoderSubscriberPlan | undefined> {
    const data = await openApiJsonRequest<unknown>(this.fetchImpl, {
      url: getQoderUserPlanUrl(this.region),
      token: jobToken,
      signal,
      timeoutMs: this.timeoutMs,
      logger: this.logger,
      operation: 'Plan',
      logCategory: 'account.plan',
    })
    return normalizePlan(data)
  }

  private async safeFetchPlan(jobToken: string, signal: AbortSignal): Promise<QoderSubscriberPlan | undefined> {
    try {
      return await this.fetchPlan(jobToken, signal)
    } catch (error) {
      if (signal.aborted) throw error
      this.logger?.warn?.('[Qoder Plan] Failed to load user plan (degraded)', redactLogValue(error))
      return undefined
    }
  }

  private async fetchStatus(
    jobToken: string,
    signal?: AbortSignal,
    machineIdentity?: Partial<QoderMachineIdentity>,
  ): Promise<QoderSubscriberStatus | undefined> {
    const { machineToken, machineType, machineCode } = normalizeMachineIdentity(machineIdentity)
    const data = await openApiJsonRequest<unknown>(this.fetchImpl, {
      url: getQoderUserStatusUrl(this.region),
      token: jobToken,
      ...machineToken ? { headers: {
        'Cosy-MachineToken': machineToken,
        ...machineType ? { 'Cosy-MachineType': machineType } : {},
        ...machineCode ? { 'Cosy-MachineCode': machineCode } : {},
      } } : {},
      signal,
      timeoutMs: this.timeoutMs,
      logger: this.logger,
      operation: 'Status',
      logCategory: 'account.status',
    })
    return normalizeStatus(data)
  }

  private async safeFetchStatus(
    jobToken: string,
    signal?: AbortSignal,
    machineIdentity?: Partial<QoderMachineIdentity>,
  ): Promise<QoderSubscriberStatus | undefined> {
    try {
      return await this.fetchStatus(jobToken, signal, machineIdentity)
    } catch (error) {
      if (signal?.aborted) throw error
      this.logger?.warn?.('[Qoder Status] Failed to load user status (degraded)', redactLogValue(error))
      return undefined
    }
  }
}
