import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'qoder-tests-'))
process.once('exit', () => rmSync(home, { recursive: true, force: true }))
process.env.HOME = home
process.env.USERPROFILE = home
for (const [key, name] of [['QODER_CONFIG_DIR', '.qoder'], ['QODERCN_CONFIG_DIR', '.qoder-cn']]) {
  const config = join(home, name)
  process.env[key] = config
  mkdirSync(join(config, '.auth'), { recursive: true })
  writeFileSync(join(config, '.auth', 'machine_id'), 'offline-test-machine')
}

globalThis.fetch = async () => { throw new Error('Tests must mock upstream requests') }
