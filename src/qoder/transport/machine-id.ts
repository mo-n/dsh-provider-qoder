import crypto from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { QoderRegion } from '../region.ts'

/** Match the native CLI's region-specific config directory overrides. */
export function qoderMachineIdPaths(
  region: QoderRegion = 'global',
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string[] {
  const prefix = region === 'china' ? 'QODERCN_' : 'QODER_'
  const cliHome = env[`${prefix}CLI_HOME`] ?? env.GEMINI_CLI_HOME ?? home
  const configDir = env[`${prefix}CONFIG_DIR`]
  const cliDir = configDir ? resolve(configDir) : join(cliHome, region === 'china' ? '.qoder-cn' : '.qoder')
  return [join(cliDir, '.auth', 'machine_id'), join(home, '.dsh', 'qoder', 'machine_id')]
}

// An unwritable fallback still needs one stable identity for this process.
const ephemeralMachineIds = new Map<string, string>()

/** Read Qoder's machine id or create the DSH-owned fallback. */
export function getMachineId(paths: readonly string[] = qoderMachineIdPaths()): string {
  for (const path of paths) {
    if (!existsSync(path)) continue
    try {
      const value = readFileSync(path, 'utf8').trim()
      if (value) return value
    } catch {
      // Try the next trusted location.
    }
  }

  const savePath = paths.at(-1)
  const machineId = (savePath === undefined ? undefined : ephemeralMachineIds.get(savePath)) ?? crypto.randomUUID()
  if (savePath !== undefined) {
    try {
      mkdirSync(dirname(savePath), { recursive: true })
      writeFileSync(savePath, machineId, { encoding: 'utf8', flag: 'wx' })
    } catch {
      // Another process may have won creation; prefer its stable value.
      try {
        const existing = readFileSync(savePath, 'utf8').trim()
        if (existing) return existing
      } catch {
        // An ephemeral id is still sufficient for this process.
      }
    }
  }
  if (savePath !== undefined) ephemeralMachineIds.set(savePath, machineId)
  return machineId
}
