/** Instance-shared authorization lifecycle. Provider I/O is delegated to Qoder transport. */
import { randomUUID } from 'node:crypto'
import { credentialKey, type CredentialProvider, type CredentialRecord } from '@deepseek-ai/dsh-credentials'
import type { QoderAuthorizationTransport, QoderAuthorizationView, QoderBrowserGrant, QoderCredentialLease, QoderLoginPhase } from '../qoder/authorization.ts'
import type { QoderRegion } from '../qoder/region.ts'
import { QoderLlmError } from '../qoder/errors.ts'
import { resolveManagedQoderPat } from './credential.ts'

export const browserAuthorizationKey = (region: QoderRegion) => credentialKey('provider-qoder', region)

interface SavedAuthorization {
  version: 1
  method: 'pat' | 'browser' | 'none'
  grant?: QoderBrowserGrant
  expired?: boolean
}
interface Attempt {
  id: string
  phase: QoderLoginPhase
  controller: AbortController
  expiresAt: number
  url?: string
  done?: Promise<void>
  cleanupFailed?: boolean
  failure?: 'storage' | 'connection' | 'authorization'
}
interface VolatileGrant { baseToken: string; grant: QoderBrowserGrant }

function decode(record: CredentialRecord | undefined, region: QoderRegion): SavedAuthorization {
  if (record === undefined) return { version: 1, method: 'pat' }
  const value = record.kind === 'grant' ? record.payload as Partial<SavedAuthorization> | null : null
  if (!value || value.version !== 1 || !['pat', 'browser', 'none'].includes(value.method ?? '')) {
    throw new QoderLlmError('Saved Qoder authorization is invalid. Remove it and sign in again.', 'AUTH')
  }
  if (value.grant) {
    const grant = value.grant
    if (grant.region !== region || typeof grant.id !== 'string' || !grant.id
      || typeof grant.refreshToken !== 'string' || !grant.refreshToken || !Number.isFinite(grant.expiresAt)
      || !grant.credentials || typeof grant.credentials.userID !== 'string' || !grant.credentials.userID
      || typeof grant.credentials.authToken !== 'string' || !grant.credentials.authToken) {
      throw new QoderLlmError('Saved Qoder browser authorization is invalid.', 'AUTH')
    }
  }
  return value as SavedAuthorization
}
// Optional TypeScript properties may be undefined, but credential records must be JSON values.
const record = (payload: SavedAuthorization): CredentialRecord => ({ kind: 'grant', payload: JSON.parse(JSON.stringify(payload)) })
const pending = (attempt?: Attempt) => attempt !== undefined && ['waiting', 'verifying', 'saving'].includes(attempt.phase)
const cancelled = () => new QoderLlmError('Qoder authorization changed or was cancelled.', 'ABORTED')

export class QoderBrowserAuthorizationManager {
  private readonly credentials: CredentialProvider
  private readonly transport: (region: QoderRegion) => QoderAuthorizationTransport
  private readonly changed: () => void
  private readonly attempts = new Map<QoderRegion, Attempt>()
  private readonly volatile = new Map<QoderRegion, VolatileGrant>()
  private readonly invalid = new Set<string>()
  private readonly renewals = new Set<Promise<QoderBrowserGrant>>()
  private readonly lifecycle = new AbortController()
  private activeRegion?: QoderRegion
  private regionGeneration = 0
  private disposed = false

  constructor(options: { credentials: CredentialProvider; region?: QoderRegion; transport(region: QoderRegion): QoderAuthorizationTransport; changed(): void }) {
    this.credentials = options.credentials
    this.transport = options.transport
    this.changed = options.changed
    this.activeRegion = options.region
  }

  activateRegion(region: QoderRegion): void {
    if (this.activeRegion === region) return
    const previous = this.activeRegion
    this.activeRegion = region
    this.regionGeneration++
    if (previous) void this.cancel(previous).catch(() => {})
  }

  private assertRegion(region: QoderRegion, generation: number): void {
    if (this.disposed || this.regionGeneration !== generation || (this.activeRegion !== undefined && this.activeRegion !== region)) throw cancelled()
  }

  private async read(region: QoderRegion): Promise<SavedAuthorization> {
    // Older host assemblies without records retain PAT support, but cannot offer browser login.
    return decode(await this.credentials.readRecord?.(browserAuthorizationKey(region)), region)
  }

  async describe(region: QoderRegion): Promise<QoderAuthorizationView> {
    const writable = await this.credentials.describeRecord?.(browserAuthorizationKey(region))
    let saved: SavedAuthorization
    try { saved = await this.read(region) } catch (error) {
      if (!(error instanceof QoderLlmError) || error.code !== 'AUTH') throw error
      return { region, method: 'none', configured: false, writable: writable?.writable ?? false, expired: true }
    }
    const live = this.volatile.get(region)
    const grant = live && live.grant.id === saved.grant?.id && live.baseToken === saved.grant?.credentials.authToken ? live.grant : saved.grant
    const attempt = this.attempts.get(region)
    const expired = grant !== undefined && (saved.expired === true || this.invalid.has(grant.id)
      || (grant.refreshExpiresAt !== undefined && grant.refreshExpiresAt <= Date.now()))
    return {
      region, method: saved.method, writable: writable?.writable ?? false,
      configured: saved.method === 'pat' ? Boolean(await resolveManagedQoderPat(this.credentials))
        : saved.method === 'browser' && grant !== undefined && !expired,
      ...grant ? { profile: { id: grant.credentials.userID, name: grant.credentials.name, email: grant.credentials.email },
        expired: saved.method === 'browser' && expired,
        unsaved: live?.grant === grant } : {},
      ...attempt ? { attempt: { id: attempt.id, phase: attempt.phase, expiresAt: attempt.expiresAt,
        ...attempt.failure ? { failure: attempt.failure } : {},
        ...pending(attempt) ? { url: attempt.url } : {} } } : {},
    }
  }

  async begin(region: QoderRegion): Promise<QoderAuthorizationView> {
    const generation = this.regionGeneration
    await this.assertWritable(region)
    this.assertRegion(region, generation)
    if (pending(this.attempts.get(region))) return this.describe(region)
    const attempt: Attempt = { id: randomUUID(), phase: 'waiting', controller: new AbortController(), expiresAt: Date.now() + 300_000 }
    this.attempts.set(region, attempt)
    attempt.done = this.login(region, attempt)
    // begin() creates the URL without waiting for website verification.
    await Promise.resolve()
    return this.describe(region)
  }

  private async login(region: QoderRegion, attempt: Attempt): Promise<void> {
    let previous: CredentialRecord | undefined
    let installed: string | undefined
    try {
      const flow = await this.transport(region).begin(attempt.controller.signal)
      this.assertAttempt(region, attempt)
      attempt.url = flow.url
      attempt.expiresAt = flow.expiresAt
      const grant = await flow.complete()
      this.assertAttempt(region, attempt)
      attempt.phase = 'saving'
      await this.credentials.modifyRecord(browserAuthorizationKey(region), async current => {
        this.assertAttempt(region, attempt)
        previous = current
        installed = grant.id
        return record({ version: 1, method: 'browser', grant })
      })
      this.assertAttempt(region, attempt)
      this.volatile.delete(region)
      attempt.phase = 'complete'
      this.changed()
    } catch (error) {
      attempt.failure = attempt.phase === 'saving' ? 'storage'
        : error instanceof QoderLlmError && ['TRANSPORT', 'SERVER', 'TIMEOUT'].includes(error.code) ? 'connection' : 'authorization'
      // Cancellation can race the store commit after its mutation callback returned.
      if (installed && attempt.controller.signal.aborted) {
        await this.credentials.modifyRecord(browserAuthorizationKey(region), async current => {
          if (decode(current, region).grant?.id !== installed) return undefined
          return previous ?? record({ version: 1, method: 'pat' })
        }).catch(() => { attempt.cleanupFailed = true })
      }
      attempt.phase = attempt.cleanupFailed ? 'failed' : attempt.controller.signal.aborted ? 'cancelled'
        : error instanceof QoderLlmError && error.code === 'TIMEOUT' && Date.now() >= attempt.expiresAt ? 'timeout' : 'failed'
    } finally {
      attempt.url = undefined
    }
  }

  private assertAttempt(region: QoderRegion, attempt: Attempt): void {
    if (this.disposed || attempt.controller.signal.aborted || this.attempts.get(region) !== attempt) throw cancelled()
  }

  async cancel(region: QoderRegion): Promise<void> {
    const attempt = this.attempts.get(region)
    if (!pending(attempt)) return
    attempt!.controller.abort()
    await attempt!.done
    if (attempt!.cleanupFailed) throw new QoderLlmError('Could not restore the previous Qoder authorization after cancellation. Reload account status.', 'INTERNAL')
  }

  async select(region: QoderRegion, method: 'pat' | 'browser' | 'none'): Promise<QoderAuthorizationView> {
    const generation = this.regionGeneration
    await this.assertWritable(region)
    await this.cancel(region)
    await this.credentials.modifyRecord(browserAuthorizationKey(region), async current => {
      this.assertRegion(region, generation)
      const saved = method === 'none' ? { version: 1 as const, method } : decode(current, region)
      if (method === 'browser' && !saved.grant) throw new QoderLlmError('Sign in to Qoder first.', 'MISSING_CREDENTIAL')
      return record(method === 'none' ? { version: 1, method } : { ...saved, method })
    })
    if (method === 'none') this.volatile.delete(region)
    this.attempts.delete(region)
    this.changed()
    return this.describe(region)
  }

  async lease(region: QoderRegion, signal?: AbortSignal): Promise<QoderCredentialLease | undefined> {
    if (signal?.aborted || this.disposed) throw cancelled()
    const saved = await this.read(region)
    if (saved.method === 'pat') return undefined
    const grant = saved.grant
    if (saved.method !== 'browser' || !grant) throw new QoderLlmError('Sign in to Qoder or select a Managed Qoder PAT.', 'MISSING_CREDENTIAL')
    if (saved.expired || this.invalid.has(grant.id)) throw new QoderLlmError('Qoder browser authorization expired. Sign in again.', 'AUTH')
    let captured = grant
    return { key: `browser:${grant.id}`, resolve: async (nextSignal, rejectedToken) => {
      // A started operation may finish with its captured token after an account change.
      if (nextSignal?.aborted || this.disposed) throw cancelled()
      const latest = await this.read(region)
      if (latest.method !== 'browser' || latest.grant?.id !== grant.id) {
        if (rejectedToken !== undefined || captured.expiresAt <= Date.now()) throw cancelled()
        return captured.credentials
      }
      const combined = nextSignal ? AbortSignal.any([nextSignal, this.lifecycle.signal]) : this.lifecycle.signal
      const renewal = this.renew(region, grant.id, combined, rejectedToken)
      this.renewals.add(renewal)
      try { captured = await renewal } finally { this.renewals.delete(renewal) }
      if (combined.aborted) throw cancelled()
      return captured.credentials
    } }
  }

  private async renew(region: QoderRegion, id: string, signal?: AbortSignal, rejectedToken?: string): Promise<QoderBrowserGrant> {
    if (this.invalid.has(id)) throw new QoderLlmError('Qoder browser authorization expired. Sign in again.', 'AUTH')
    const snapshot = await this.read(region)
    const fresh = snapshot.method === 'browser' && snapshot.grant?.id === id ? snapshot.grant : undefined
    if (fresh && !snapshot.expired && !this.volatile.has(region) && fresh.expiresAt > Date.now() + 300_000
      && rejectedToken !== fresh.credentials.authToken) return fresh
    let rotated: QoderBrowserGrant | undefined
    let baseToken: string | undefined
    try {
      await this.credentials.modifyRecord(browserAuthorizationKey(region), async current => {
        const saved = decode(current, region)
        if (this.disposed || signal?.aborted || saved.method !== 'browser' || saved.grant?.id !== id) throw cancelled()
        if (saved.expired) throw new QoderLlmError('Qoder browser authorization expired. Sign in again.', 'AUTH')
        const volatile = this.volatile.get(region)
        baseToken = saved.grant.credentials.authToken
        const source = volatile?.grant.id === id && volatile.baseToken === baseToken ? volatile.grant : saved.grant
        // Caller cancellation must not discard a rotation already accepted upstream.
        rotated = await this.transport(region).refresh(source, this.lifecycle.signal, rejectedToken)
        // Once upstream rotated a credential, save it even if its caller just cancelled.
        return rotated === saved.grant ? undefined : record({ ...saved, grant: rotated })
      })
      this.volatile.delete(region)
      return rotated!
    } catch (error) {
      if (error instanceof QoderLlmError && error.code === 'AUTH') {
        this.invalid.add(id)
        await this.credentials.modifyRecord(browserAuthorizationKey(region), async current => {
          const saved = decode(current, region)
          return saved.grant?.id === id ? record({ ...saved, expired: true }) : undefined
        }).catch(() => {})
      }
      // A successful token rotation must survive a failed disk write in this process.
      if (rotated && baseToken) {
        const saved = await this.read(region)
        if (saved.method === 'browser' && saved.grant?.id === id && saved.grant.credentials.authToken === rotated.credentials.authToken) return saved.grant
        if (saved.method === 'browser' && saved.grant?.id === id && saved.grant.credentials.authToken === baseToken) {
          this.volatile.set(region, { baseToken, grant: rotated })
          return rotated
        }
      }
      throw error
    }
  }

  private async assertWritable(region: QoderRegion): Promise<void> {
    const info = await this.credentials.describeRecord?.(browserAuthorizationKey(region))
    if (!info?.writable) throw new QoderLlmError('Qoder authorization storage is read-only or unsupported.', 'INTERNAL')
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.lifecycle.abort()
    for (const attempt of this.attempts.values()) attempt.controller.abort()
    await Promise.all([...this.attempts.values()].map(attempt => attempt.done))
    await Promise.allSettled(this.renewals)
    this.volatile.clear()
    this.invalid.clear()
  }
}
