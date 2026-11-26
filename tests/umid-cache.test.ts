import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { readQoderUmidCache } from '../src/qoder/transport/index.ts'
import { DefaultQoderTransport } from '../src/qoder/transport/default-transport.ts'
import type { QoderRegion } from '../src/qoder/region.ts'

const identity = { machineToken: 'cached-token', machineType: '8', machineCode: 'cached-code' }
const cache = { version: 1, environment: 4, platform: 'linux', arch: 'arm64', info: identity }

async function fixture(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), 'qoder-umid-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  return { home, env: {}, platform: 'linux' as const, arch: 'arm64' }
}

test('UMID cache uses the native CLI config and home precedence for both regions', async t => {
  const options = await fixture(t)
  const { home } = options
  const globalHome = join(home, 'global-home')
  const chinaHome = join(home, 'china-home')
  const gemini = join(home, 'gemini')
  const config = join(home, 'config')
  const cases: Array<[QoderRegion, NodeJS.ProcessEnv, string]> = [
    ['global', {}, join(home, '.qoder')],
    ['china', {}, join(home, '.qoder-cn')],
    ['global', { GEMINI_CLI_HOME: gemini }, join(gemini, '.qoder')],
    ['china', { GEMINI_CLI_HOME: gemini }, join(gemini, '.qoder-cn')],
    ['global', { QODER_CLI_HOME: globalHome, GEMINI_CLI_HOME: gemini }, join(globalHome, '.qoder')],
    ['china', { QODERCN_CLI_HOME: chinaHome, GEMINI_CLI_HOME: gemini }, join(chinaHome, '.qoder-cn')],
    ['global', { QODER_CONFIG_DIR: config, QODER_CLI_HOME: globalHome }, config],
    ['china', { QODERCN_CONFIG_DIR: config, QODERCN_CLI_HOME: chinaHome }, config],
  ]
  for (const [region, env, dir] of cases) {
    const path = join(dir, 'umid-cache.json')
    await mkdir(dir, { recursive: true })
    const contents = JSON.stringify({ ...cache, environment: region === 'china' ? 0 : 4 })
    await writeFile(path, contents)
    assert.deepEqual(await readQoderUmidCache(region, { ...options, env }), identity)
    assert.equal(await readFile(path, 'utf8'), contents)
    await rm(path)
  }
})

test('UMID cache rejects missing, non-regular, oversized and invalid caches', async t => {
  const options = await fixture(t)
  const path = join(options.home, '.qoder', 'umid-cache.json')
  const read = () => readQoderUmidCache(undefined, options)
  assert.equal(await read(), undefined)
  await mkdir(path, { recursive: true })
  assert.equal(await read(), undefined)
  await rm(path, { recursive: true })
  const valid = JSON.stringify(cache)
  const limit = 1024 * 1024
  await writeFile(path, valid.padEnd(limit))
  assert.deepEqual(await read(), identity)
  for (const invalid of [
    valid.padEnd(limit + 1), '{', 'null', '[]',
    JSON.stringify({ ...cache, version: '1' }),
    JSON.stringify({ ...cache, version: 2 }),
    JSON.stringify({ ...cache, environment: 0 }),
    JSON.stringify({ ...cache, platform: 'darwin' }),
    JSON.stringify({ ...cache, arch: 'x64' }),
    ...[undefined, null, [], {}, { machineToken: 42 }, { machineToken: '' }, { machineToken: ' \t ' }]
      .map(info => JSON.stringify({ ...cache, info })),
  ]) {
    await writeFile(path, invalid)
    assert.equal(await read(), undefined)
  }
  await writeFile(path, JSON.stringify({ ...cache, info: { machineToken: ' token ', machineType: 7, machineCode: '  ' } }))
  assert.deepEqual(await read(), { machineToken: 'token' })
})

test('DefaultQoderTransport uses only injected UMID resolvers for account reads and browser login', async t => {
  const { home } = await fixture(t)
  const previous = process.env.QODER_CONFIG_DIR
  process.env.QODER_CONFIG_DIR = home
  t.after(() => {
    if (previous === undefined) delete process.env.QODER_CONFIG_DIR
    else process.env.QODER_CONFIG_DIR = previous
  })
  await writeFile(join(home, 'umid-cache.json'), JSON.stringify({ ...cache, platform: process.platform, arch: process.arch }))
  assert.deepEqual(await readQoderUmidCache(), identity)
  const checks = [
    { resolver: {}, expected: [null, null, null] },
    { resolver: { resolveMachineToken: () => 'explicit-token' }, expected: ['explicit-token', null, null] },
    { resolver: { resolveMachineIdentity: () => readQoderUmidCache() }, expected: Object.values(identity) },
  ]
  for (const { resolver, expected } of checks) {
    let received: Headers | undefined
    const transport = new DefaultQoderTransport({
      ...resolver,
      region: 'global',
      resolvePat: async () => 'pt-test',
      resolveMachineId: () => 'machine-id-test',
      fetch: async (input, init) => {
        switch (new URL(String(input)).pathname) {
          case '/api/v1/jobToken/exchange': return Response.json({ token: 'job-token-test' })
          case '/api/v1/userinfo': return Response.json({ id: 'subscriber' })
          case '/api/v2/quota/usage': return Response.json({})
          case '/api/v2/user/plan': return Response.json({})
          case '/api/v3/user/status':
            received = new Headers(init?.headers)
            return Response.json({})
          default: throw new Error('Unexpected mocked route')
        }
      },
    })
    await transport.readAccount()
    assert.ok(received)
    assert.deepEqual(['Token', 'Type', 'Code'].map(field => received!.get(`Cosy-Machine${field}`)), expected)
    const flow = await transport.authorization.begin(new AbortController().signal)
    const params = new URL(flow.url).searchParams
    assert.deepEqual(['token', 'type', 'code'].map(field => params.get(`machine_${field}`)), expected)
  }
})
