/** Browser-safe contracts; grants and leases are host-only secrets, views are public. */
import type { QoderCredentials } from './transport/wire/credentials.ts'
import type { QoderRegion } from './region.ts'

export interface QoderBrowserGrant {
  id: string
  region: QoderRegion
  credentials: QoderCredentials
  refreshToken: string
  expiresAt: number
  refreshExpiresAt?: number
}

/** Captured once per operation, preserving subscriber identity across retries. */
export interface QoderCredentialLease {
  key: string
  resolve(signal?: AbortSignal, rejectedToken?: string): Promise<QoderCredentials>
}

export interface QoderBrowserLoginFlow {
  url: string
  expiresAt: number
  complete(): Promise<QoderBrowserGrant>
}

export interface QoderAuthorizationTransport {
  begin(signal: AbortSignal): Promise<QoderBrowserLoginFlow>
  refresh(grant: QoderBrowserGrant, signal?: AbortSignal, rejectedToken?: string): Promise<QoderBrowserGrant>
}

export type QoderLoginPhase = 'waiting' | 'verifying' | 'saving' | 'complete' | 'cancelled' | 'timeout' | 'failed'
export interface QoderAuthorizationView {
  region: QoderRegion
  method: 'pat' | 'browser' | 'none'
  configured: boolean
  writable: boolean
  profile?: { id: string; name: string; email: string }
  expired?: boolean
  unsaved?: boolean
  attempt?: { id: string; phase: QoderLoginPhase; url?: string; expiresAt: number; failure?: 'storage' | 'connection' | 'authorization' }
}
