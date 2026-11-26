import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { QoderRegion } from '../region.ts'
import { qoderCliConfigDir } from './machine-id.ts'
import { normalizeMachineIdentity } from './wire/credentials.ts'

export interface QoderMachineIdentity {
  machineToken: string
  machineType?: string
  machineCode?: string
}

const maxCacheBytes = 1024 * 1024

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Read the native CLI's region- and host-specific UMID cache. */
export async function readQoderUmidCache(
  region: QoderRegion = 'global',
  options: { env?: NodeJS.ProcessEnv; home?: string; platform?: NodeJS.Platform; arch?: string } = {},
): Promise<QoderMachineIdentity | undefined> {
  try {
    const path = join(qoderCliConfigDir(region, options.env, options.home), 'umid-cache.json')
    const stat = await lstat(path)
    if (!stat.isFile() || stat.size > maxCacheBytes) return undefined
    const bytes = await readFile(path)
    if (bytes.length > maxCacheBytes) return undefined
    const cache: unknown = JSON.parse(bytes.toString('utf8'))
    if (!isRecord(cache) || cache.version !== 1 || cache.environment !== (region === 'china' ? 0 : 4)
      || cache.platform !== (options.platform ?? process.platform) || cache.arch !== (options.arch ?? process.arch)
      || !isRecord(cache.info)) return undefined

    const { machineToken, ...optional } = normalizeMachineIdentity(cache.info)
    return machineToken ? { machineToken, ...optional } : undefined
  } catch {
    return undefined
  }
}
