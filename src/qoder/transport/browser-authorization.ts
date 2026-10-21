/** qodercli 1.1.73 PKCE device flow. No website password or agent runtime is needed. */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { QoderAuthorizationTransport, QoderBrowserGrant, QoderBrowserLoginFlow } from '../authorization.ts'
import { QoderLlmError } from '../errors.ts'
import { QoderAuthService } from './auth.ts'
import { resolveQoderEndpoints, type QoderRegion } from './endpoints.ts'
import { getMachineId, qoderMachineIdPaths } from './machine-id.ts'
import { defaultMaxJsonBytes, openApiJsonRequest, readLimitedText } from './request.ts'
import { defaultUserAgent } from './wire/cosy.ts'

interface DeviceTokenResponse {
  token?: string
  device_token?: string
  refresh_token?: string
  expires_at?: string | number
  expires_in?: number
  refresh_token_expires_at?: string | number
  refresh_token_expires_in?: number
}

export class QoderBrowserAuthorization implements QoderAuthorizationTransport {
  private readonly options: {
    region: QoderRegion
    fetch?: typeof fetch
    resolveMachineId?: () => string
    pollIntervalMs?: number
    loginTimeoutMs?: number
  }

  constructor(options: QoderBrowserAuthorization['options']) { this.options = options }

  async begin(signal: AbortSignal): Promise<QoderBrowserLoginFlow> {
    signal.throwIfAborted()
    const verifier = randomBytes(48).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const nonce = randomUUID()
    const machineID = (this.options.resolveMachineId ?? (() => getMachineId(qoderMachineIdPaths(this.options.region))))()
    const query = new URLSearchParams({ challenge, challenge_method: 'S256', nonce, machine_id: machineID,
      client_id: 'e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb' })
    const origin = this.options.region === 'china' ? 'https://qoder.cn' : 'https://qoder.com'
    const expiresAt = Date.now() + (this.options.loginTimeoutMs ?? 300_000)
    const deadline = AbortSignal.timeout(Math.max(1, expiresAt - Date.now()))
    const combined = AbortSignal.any([signal, deadline])
    return {
      url: `${origin}/device/selectAccounts?${query}`, expiresAt,
      complete: async () => {
        try {
          const poll = new URL(`${resolveQoderEndpoints(this.options.region).openApiUrl}/api/v1/deviceToken/poll`)
          poll.search = new URLSearchParams({ nonce, verifier, challenge_method: 'S256' }).toString()
          while (!combined.aborted) {
            let response: Response
            try {
              // Deliberately exclude this credential-bearing URL from request logging and errors.
              response = await (this.options.fetch ?? fetch)(poll, {
                headers: { accept: 'application/json', 'user-agent': defaultUserAgent },
                signal: AbortSignal.any([combined, AbortSignal.timeout(15_000)]),
              })
            } catch {
              if (combined.aborted) break
              await delay(this.options.pollIntervalMs ?? 1000, undefined, { signal: combined })
              continue
            }
            if (response.status === 404 || response.status >= 500 || response.status === 429) {
              await response.body?.cancel()
              await delay(this.options.pollIntervalMs ?? 1000, undefined, { signal: combined })
              continue
            }
            if (!response.ok) {
              await response.body?.cancel()
              throw new QoderLlmError('Qoder browser authorization was rejected.', 'AUTH')
            }
            const raw = JSON.parse(await readLimitedText(response, defaultMaxJsonBytes, 'Qoder browser authorization')) as DeviceTokenResponse
            return await this.grant(raw, machineID, combined)
          }
          throw new QoderLlmError('Qoder browser login timed out.', 'TIMEOUT')
        } catch (error) {
          if (signal.aborted) throw new QoderLlmError('Qoder browser login was cancelled.', 'ABORTED')
          if (deadline.aborted) throw new QoderLlmError('Qoder browser login timed out.', 'TIMEOUT')
          if (error instanceof QoderLlmError) throw error
          throw new QoderLlmError('Qoder browser authorization returned an invalid response.', 'MALFORMED_RESPONSE')
        }
      },
    }
  }

  async refresh(grant: QoderBrowserGrant, signal?: AbortSignal, rejectedToken?: string): Promise<QoderBrowserGrant> {
    if (grant.region !== this.options.region) throw new QoderLlmError('Qoder authorization region mismatch.', 'AUTH')
    const forced = rejectedToken !== undefined && rejectedToken === grant.credentials.authToken
    if (!forced && grant.expiresAt > Date.now() + 300_000) return grant
    if (grant.refreshExpiresAt !== undefined && grant.refreshExpiresAt <= Date.now()) {
      throw new QoderLlmError('Qoder browser authorization expired. Sign in again.', 'AUTH')
    }
    const raw = await openApiJsonRequest<DeviceTokenResponse>(this.options.fetch ?? fetch, {
      url: `${resolveQoderEndpoints(this.options.region).openApiUrl}/api/v1/deviceToken/refresh`,
      body: { refresh_token: grant.refreshToken, machine_id: grant.credentials.machineID }, signal,
      operation: 'BrowserRefresh',
    })
    const token = raw.device_token ?? raw.token
    if (!token || typeof token !== 'string' || !raw.refresh_token || typeof raw.refresh_token !== 'string') {
      throw new QoderLlmError('Qoder refresh returned incomplete credentials.', 'MALFORMED_RESPONSE')
    }
    // Rotation must be saved even if a subsequent optional profile lookup would fail.
    return { ...grant, credentials: { ...grant.credentials, authToken: token }, refreshToken: raw.refresh_token,
      expiresAt: deviceExpiry(raw.expires_at, raw.expires_in) ?? Date.now() + 86_400_000,
      refreshExpiresAt: refreshExpiry(raw) ?? grant.refreshExpiresAt }
  }

  private async grant(raw: DeviceTokenResponse, machineID: string, signal: AbortSignal): Promise<QoderBrowserGrant> {
    if (!raw.token || typeof raw.token !== 'string' || !raw.refresh_token || typeof raw.refresh_token !== 'string') {
      throw new QoderLlmError('Qoder browser authorization returned incomplete credentials.', 'MALFORMED_RESPONSE')
    }
    const auth = new QoderAuthService({ region: this.options.region, fetch: this.options.fetch })
    const credentials = await auth.credentialsForToken(raw.token, machineID, signal)
    return { id: randomUUID(), region: this.options.region, credentials, refreshToken: raw.refresh_token,
      expiresAt: deviceExpiry(raw.expires_at, raw.expires_in) ?? Date.now() + 86_400_000, refreshExpiresAt: refreshExpiry(raw) }
  }
}

function refreshExpiry(raw: DeviceTokenResponse): number | undefined {
  return deviceExpiry(raw.refresh_token_expires_at, raw.refresh_token_expires_in)
}

/** Device-flow durations are seconds, including multi-day refresh-token lifetimes. */
function deviceExpiry(absolute?: string | number, seconds?: number): number | undefined {
  if (absolute !== undefined) {
    const parsed = typeof absolute === 'string' ? Date.parse(absolute) : absolute > 1e12 ? absolute : absolute * 1000
    if (Number.isFinite(parsed)) return parsed
  }
  if (typeof seconds === 'number' && Number.isFinite(seconds * 1000) && seconds > 0) return Date.now() + seconds * 1000
  return undefined
}
