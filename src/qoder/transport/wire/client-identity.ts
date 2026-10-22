/** Client identity shared by Qoder model protocols and Open API exchanges. */
import { hostname } from 'node:os'

export const qoderIdeVersion = '1.1.73'
export const qoderClientType = '5'
export const defaultUserAgent = `qoder/${qoderIdeVersion}`

export function qoderMachineOs(platform: string = process.platform, arch: string = process.arch): string {
  const architecture = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : arch
  return `${architecture}_${platform}`
}

/** Identity injected by qodercli's common infer-sse HTTP request pipeline. */
export function qoderModelClientHeaders(): Record<string, string> {
  const machineHostname = hostname().replace(/[^\x20-\x7e]/gu, '').trim()
  return {
    'Cosy-Version': qoderIdeVersion,
    'Cosy-ClientType': qoderClientType,
    'Cosy-MachineOS': qoderMachineOs(),
    ...machineHostname ? { 'Cosy-MachineHostname': machineHostname } : {},
  }
}
