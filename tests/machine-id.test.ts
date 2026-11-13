import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { getMachineId, qoderMachineIdPaths } from '../src/qoder/transport/machine-id.ts'
import { createQoderTransport } from '../src/qoder/transport/index.ts'
import { deferred, mockTime } from './helpers/timing.ts'

const uuidV4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/

async function fixtureDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'qoder-machine-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

test('Qoder machine ID lookup honors CLI config overrides and China branding', () => {
  const home = join(tmpdir(), 'offline-home')
  const configDir = join(tmpdir(), 'offline-cli')
  const cliHome = join(tmpdir(), 'offline-cn')
  assert.equal(qoderMachineIdPaths('global', { QODER_CONFIG_DIR: configDir }, home)[0],
    join(configDir, '.auth', 'machine_id'))
  assert.equal(qoderMachineIdPaths('china', { QODERCN_CLI_HOME: cliHome }, home)[0],
    join(cliHome, '.qoder-cn', '.auth', 'machine_id'))
  assert.equal(qoderMachineIdPaths('global', {}, home)[0], join(home, '.qoder', '.auth', 'machine_id'))
})

test('cold-start derivation matches Qoder CLI 1.1.86 and survives file deletion', async t => {
  const path = join(await fixtureDirectory(t), 'machine_id')
  const uuid = '  01234567-89AB-CDEF-8123-456789ABCDEF '
  const fixtures = [
    [{ platform: 'win32', uuid }, 'c2f85df9-ffa4-4580-93b4-fc4aeefcbaab'],
    [{ platform: 'linux', uuid: 'AABBCCDD-0000-1122-3344-556677889900' }, '6db98bab-060f-4739-aa3f-7c6c67cf1f41'],
    [{ platform: 'darwin', uuid, serial: 'C02TEST1234' }, '43303254-4553-442d-b132-336d3443302d'],
    [{ platform: 'darwin', uuid, serial: ' SYSTEM SERIAL NUMBER ' }, '61484326-45b4-4758-8a4f-73570ca070ec'],
  ] as const
  for (const [hardware, expected] of fixtures) {
    assert.equal(await getMachineId([path], async () => hardware), expected)
    assert.equal(await readFile(path, 'utf8'), expected)
    await unlink(path)
    assert.equal(await getMachineId([path], async () => hardware), expected)
    await unlink(path)
  }
})

test('the official and existing DSH files take precedence over hardware probing', async t => {
  const directory = await fixtureDirectory(t)
  const official = join(directory, 'official')
  const dsh = join(directory, 'dsh')
  let probes = 0
  const probe = async () => { probes++; return undefined }
  await writeFile(official, ' official-id\n')
  await writeFile(dsh, 'old-dsh-id')
  assert.equal(await getMachineId([official, dsh], probe), 'official-id')
  await unlink(official)
  assert.equal(await getMachineId([official, dsh], probe), 'old-dsh-id')
  assert.equal(probes, 0)
})

test('unusable hardware falls back to a persisted random UUID', async t => {
  const path = join(await fixtureDirectory(t), 'machine_id')
  const machineID = await getMachineId([path], async () => ({ platform: 'linux', uuid: 'FF-FF' }))
  assert.match(machineID, uuidV4)
  assert.equal(await readFile(path, 'utf8'), machineID)
})

test('hardware timeout aborts the probe and persists a random UUID', async t => {
  const path = join(await fixtureDirectory(t), 'machine_id')
  const time = mockTime(t)
  const started = deferred<AbortSignal>()
  const pending = getMachineId([path], signal => {
    started.resolve(signal)
    return new Promise(() => {})
  })
  const signal = await started.promise
  time.tick(999)
  assert.equal(signal.aborted, false)
  time.tick(1)
  const machineID = await pending
  assert.equal(signal.aborted, true)
  assert.match(machineID, uuidV4)
  assert.equal(await readFile(path, 'utf8'), machineID)
})

test('parallel regional initialization shares a probe and adopts an ID written by another caller', async t => {
  const directory = await fixtureDirectory(t)
  const path = join(directory, 'machine_id')
  let probes = 0
  const probe = async () => {
    probes++
    await writeFile(path, 'winner-id', { flag: 'wx' })
    return undefined
  }
  const ids = await Promise.all([
    getMachineId([join(directory, 'global'), path], probe),
    getMachineId([join(directory, 'china'), path], probe),
  ])
  assert.deepEqual(ids, ['winner-id', 'winner-id'])
  assert.equal(probes, 1)
  assert.equal(await readFile(path, 'utf8'), 'winner-id')
})

test('failed persistence reuses the process-local ID and preserves an existing empty file', async t => {
  const directory = await fixtureDirectory(t)
  const blocked = join(directory, 'blocked')
  const empty = join(directory, 'empty')
  await writeFile(blocked, 'parent is a file')
  await writeFile(empty, '\n')
  for (const path of [join(blocked, 'machine_id'), empty]) {
    let probes = 0
    const probe = async () => { probes++; return undefined }
    const id = await getMachineId([path], probe)
    assert.match(id, uuidV4)
    assert.equal(await getMachineId([path], probe), id)
    assert.equal(probes, 1)
  }
  assert.equal(await readFile(empty, 'utf8'), '\n')
})

test('China transport signs a legacy credential using the China machine ID', async t => {
  const config = await fixtureDirectory(t)
  const previous = process.env.QODERCN_CONFIG_DIR
  process.env.QODERCN_CONFIG_DIR = config
  t.after(() => {
    if (previous === undefined) delete process.env.QODERCN_CONFIG_DIR
    else process.env.QODERCN_CONFIG_DIR = previous
  })
  await mkdir(join(config, '.auth'))
  await writeFile(join(config, '.auth', 'machine_id'), 'china-machine')
  const transport = createQoderTransport({
    region: 'china',
    resolvePat: async () => assert.fail('browser credential lease is active'),
    resolveCredential: async () => ({ key: 'offline', resolve: async () => ({
      userID: 'offline-user', authToken: 'offline-token', name: '', email: '',
    }) }),
    fetch: async (_input, init) => {
      assert.equal(new Headers(init?.headers).get('Cosy-Machineid'), 'china-machine')
      return new Response(JSON.stringify({ assistant: [{ key: 'offline-model', enable: true }] }))
    },
  })
  assert.equal((await transport.discoverModels())[0]?.id, 'offline-model')
})
