/** Browser-safe Qoder subscriber account and quota types. */

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
