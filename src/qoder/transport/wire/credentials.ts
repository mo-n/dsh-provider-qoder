import type { QoderMachineIdentity } from '../umid-cache.ts'

/** Subscriber credential material shared across Qoder endpoint protocols. */
export interface QoderCredentials {
  userID: string
  authToken: string
  name: string
  email: string
  machineID?: string
  machineToken?: string
  machineType?: string
  machineCode?: string
  organizationId?: string
  organizationTags?: string[]
  dataPolicyAgreed?: boolean
}

export interface QoderMachineIdentityResolvers {
  resolveMachineIdentity?: () => QoderMachineIdentity | undefined | Promise<QoderMachineIdentity | undefined>
  resolveMachineToken?: () => string | undefined | Promise<string | undefined>
}

function nonemptyString(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() || undefined : undefined
}

export function normalizeMachineIdentity(
  identity?: Partial<Record<keyof QoderMachineIdentity, unknown>> | string,
): Partial<QoderMachineIdentity> {
  const fields = typeof identity === 'string' ? { machineToken: identity } : identity
  const machineToken = nonemptyString(fields?.machineToken)
  const machineType = nonemptyString(fields?.machineType)
  const machineCode = nonemptyString(fields?.machineCode)
  return {
    ...machineToken ? { machineToken } : {},
    ...machineType ? { machineType } : {},
    ...machineCode ? { machineCode } : {},
  }
}

/** Resolve an injected UMID identity, with support for token-only callers. */
export async function resolveQoderMachineIdentity(options: QoderMachineIdentityResolvers): Promise<Partial<QoderMachineIdentity>> {
  const identity = normalizeMachineIdentity(await options.resolveMachineIdentity?.())
  if (identity.machineToken) return identity
  return normalizeMachineIdentity(await options.resolveMachineToken?.())
}

export function machineIdentityParams({ machineToken, machineType, machineCode }: Partial<QoderMachineIdentity>): Record<string, string> {
  return {
    ...machineToken ? { machine_token: machineToken } : {},
    ...machineType ? { machine_type: machineType } : {},
    ...machineCode ? { machine_code: machineCode } : {},
  }
}
