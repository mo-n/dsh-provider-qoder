import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
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

type HardwareIdentity = { platform: NodeJS.Platform; uuid?: string; serial?: string }
type HardwareProbe = (signal: AbortSignal) => Promise<HardwareIdentity | undefined>

const exec = promisify(execFile)
const hardwareProbeTimeoutMs = 1000
const pendingMachineIds = new Map<string, Promise<string>>()
const ephemeralMachineIds = new Map<string, string>()

async function probeHardware(signal: AbortSignal): Promise<HardwareIdentity | undefined> {
  const platform = process.platform
  switch (platform) {
    case 'win32': {
      const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      const { stdout } = await exec(powershell, ['-NoProfile', '-NonInteractive', '-Command',
        '(Get-CimInstance -ClassName Win32_ComputerSystemProduct).UUID'], { signal, windowsHide: true })
      return { platform, uuid: stdout }
    }
    case 'darwin': {
      const { stdout } = await exec('/usr/sbin/ioreg', ['-c', 'IOPlatformExpertDevice', '-d', '2'], { signal })
      return {
        platform,
        serial: stdout.match(/"IOPlatformSerialNumber"\s*=\s*"([^"]*)"/)?.[1],
        uuid: stdout.match(/"IOPlatformUUID"\s*=\s*"([^"]*)"/)?.[1],
      }
    }
    case 'linux': {
      const dmi = await readNonempty('/sys/class/dmi/id/product_uuid', signal)
      if (dmi) return { platform, uuid: dmi }
      const cpuInfo = await readFile('/proc/cpuinfo', { encoding: 'utf8', signal })
      return { platform, uuid: cpuInfo.match(/^serial[ \t]*:[ \t]*(.*)$/im)?.[1] }
    }
  }
}

function usableHardwareValue(value: string): boolean {
  const normalized = value.toLowerCase()
  if (['-', 'unknown', 'none', 'not specified', 'system serial number', 'to be filled by o.e.m.'].includes(normalized)) return false
  const alphanumeric = normalized.replace(/[^a-z0-9]/g, '')
  return alphanumeric.length > 0 && !/^0+$|^f+$/.test(alphanumeric)
}

/** Match the serial and salted UUID branches in Qoder CLI 1.1.86. */
function deriveMachineId({ platform, serial, uuid }: HardwareIdentity): string | undefined {
  const serialValue = serial?.trim() ?? ''
  const uuidValue = uuid?.trim().toLowerCase() ?? ''
  let seed: Buffer
  if (platform === 'darwin' && usableHardwareValue(serialValue)) {
    const s = serialValue.repeat(Math.ceil(20 / serialValue.length)).slice(0, 20)
    seed = Buffer.from(`${s.slice(0, 7)}-${s.slice(7, 10)}m${s.slice(10, 13)}-${s.slice(13)}`, 'utf8')
  } else if (usableHardwareValue(uuidValue)) {
    seed = crypto.createHash('sha256').update(`qoder-machine-id:v1:${platform}:${uuidValue}`).digest()
  } else {
    return
  }
  const bytes = seed.subarray(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-')
}

async function probeMachineId(probe: HardwareProbe): Promise<string | undefined> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<undefined>(resolve => {
      timer = setTimeout(() => {
        resolve(undefined)
        controller.abort()
      }, hardwareProbeTimeoutMs)
    })
    const hardware = await Promise.race([probe(controller.signal), timeout])
    return hardware && deriveMachineId(hardware)
  } catch {
    // Some hosts cannot expose a usable hardware identifier.
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

async function readNonempty(path: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    return (await readFile(path, { encoding: 'utf8', signal })).trim() || undefined
  } catch {
    return undefined
  }
}

async function createMachineId(path: string, probe: HardwareProbe): Promise<string> {
  const existing = await readNonempty(path)
  if (existing) return existing
  const machineId = ephemeralMachineIds.get(path) ?? await probeMachineId(probe) ?? crypto.randomUUID()
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, machineId, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    ephemeralMachineIds.delete(path)
    return machineId
  } catch {
    const winner = await readNonempty(path)
    if (winner) return winner
    ephemeralMachineIds.set(path, machineId)
    return machineId
  }
}

/** Read Qoder's machine id or create the DSH-owned fallback. */
export async function getMachineId(
  paths: readonly string[] = qoderMachineIdPaths(),
  probe: HardwareProbe = probeHardware,
): Promise<string> {
  for (const path of paths) {
    const value = await readNonempty(path)
    if (value) return value
  }

  const savePath = paths.at(-1)
  if (savePath === undefined) return await probeMachineId(probe) ?? crypto.randomUUID()
  const path = resolve(savePath)
  const pending = pendingMachineIds.get(path)
  if (pending) return pending
  const creation = createMachineId(path, probe).finally(() => pendingMachineIds.delete(path))
  pendingMachineIds.set(path, creation)
  return creation
}
