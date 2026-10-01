import crypto from 'node:crypto'
import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildAuthHeaders, computeSigPath, qoderMachineOs, qoderIdeVersion } from '../src/qoder/transport/wire/cosy.ts'
import { getQoderChatUrl } from '../src/qoder/transport/endpoints.ts'
import { getMachineId, qoderMachineIdPaths } from '../src/qoder/transport/machine-id.ts'

test('computeSigPath strips the /algo prefix', () => {
  assert.equal(computeSigPath('https://api3.qoder.sh/algo/api/v2/service'), '/api/v2/service')
})

test('getMachineId accepts an isolated storage location', () => {
  const path = join(tmpdir(), `qoder-machine-${crypto.randomUUID()}`, 'machine_id')
  const machineId = getMachineId([path])
  assert.ok(machineId.length > 0)
  assert.equal(getMachineId([path]), machineId)
})

test('buildAuthHeaders creates the required bounded COSY headers', () => {
  const body = Buffer.from('encoded-body')
  const headers = buildAuthHeaders(body, getQoderChatUrl(), {
    userID: 'user-123',
    authToken: 'jt-token',
    name: 'User',
    email: 'user@example.com',
    machineID: 'machine-123',
  })
  assert.ok(headers.Authorization.startsWith('Bearer COSY.'))
  assert.equal(headers['Cosy-User'], 'user-123')
  const [, payload, signature] = headers.Authorization.split('.')
  const expected = crypto.createHash('md5').update([
    payload, headers['Cosy-Key'], headers['Cosy-Date'], body.toString(),
    '/api/v2/service/pro/sse/agent_chat_generation',
  ].join('\n')).digest('hex')
  assert.equal(signature, expected)
  assert.equal(headers['Cosy-Bodylength'], undefined)
  assert.equal(headers['Cosy-Sigpath'], undefined)
})


test('client OS metadata matches native CLI platforms', () => {
  assert.equal(qoderMachineOs('darwin', 'arm64'), 'aarch64_darwin')
  assert.equal(qoderMachineOs('win32', 'x64'), 'x86_64_win32')
  assert.equal(qoderMachineOs('linux', 'x64'), 'x86_64_linux')
})

test('COSY carries organization and privacy context in both headers and encrypted user info', t => {
  t.mock.method(crypto, 'randomUUID', () => '01234567-89ab-4cde-8fab-0123456789ab')
  const headers = buildAuthHeaders('offline-body', getQoderChatUrl(), {
    userID: 'offline-user', authToken: 'jt-offline', name: 'Offline', email: '', machineID: 'offline-machine',
    organizationId: 'offline-org', organizationTags: ['Security', 'JadeKey'], dataPolicyAgreed: false,
  })
  const payload = JSON.parse(Buffer.from(headers.Authorization.split('.')[1], 'base64').toString())
  const key = Buffer.from('0123456789ab4cde')
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, key)
  const info = JSON.parse(Buffer.concat([decipher.update(Buffer.from(payload.info, 'base64')), decipher.final()]).toString())
  assert.deepEqual(info, {
    uid: 'offline-user', security_oauth_token: 'jt-offline', organization_id: 'offline-org',
    organization_tags: ['Security', 'JadeKey'], data_policy_agreed: false,
  })
  assert.equal(headers['Cosy-Organization-Id'], 'offline-org')
  assert.equal(headers['Cosy-Organization-Tags'], 'Security,JadeKey')
  assert.equal(headers['Cosy-Data-Policy'], 'disagree')
  assert.equal(headers['Cosy-Version'], qoderIdeVersion)
  assert.equal(payload.cosyVersion, qoderIdeVersion)
  assert.equal(headers['Cosy-Business-Product'], 'cli')
  assert.equal(headers['Cosy-Business-Type'], 'agent')
  assert.equal(headers['Cosy-Scene'], 'assistant')
  assert.equal(headers['Cosy-Clientip'], undefined)
  assert.equal(headers['Cosy-Machinetoken'], 'offline-machine')
})

test('COSY metadata requests use the CLI Machine ID fallback and explicit privacy choice', () => {
  const headers = buildAuthHeaders(null, 'https://api3.qoder.sh/algo/api/v2/model/list?Encode=1', {
    userID: 'offline-user', authToken: 'jt-offline', name: '', email: '', machineID: 'offline-machine', dataPolicyAgreed: true,
  })
  assert.equal(headers['Cosy-Clientip'], 'offline-machine')
  assert.equal(headers['Cosy-Machinetoken'], 'offline-machine')
  assert.equal(headers['Cosy-Data-Policy'], 'agree')
  assert.equal(headers['Cosy-Organization-Id'], undefined)
})


test('Machine ID lookup honors CLI config overrides and China branding', () => {
  assert.equal(qoderMachineIdPaths('global', { QODER_CONFIG_DIR: '/tmp/offline-cli' }, '/tmp/offline-home')[0],
    '/tmp/offline-cli/.auth/machine_id')
  assert.equal(qoderMachineIdPaths('china', { QODERCN_CLI_HOME: '/tmp/offline-cn' }, '/tmp/offline-home')[0],
    '/tmp/offline-cn/.qoder-cn/.auth/machine_id')
  assert.equal(qoderMachineIdPaths('global', {}, '/tmp/offline-home')[0], '/tmp/offline-home/.qoder/.auth/machine_id')
})

test('an unwritable Machine ID fallback remains stable across authentication refreshes', () => {
  const path = join(tmpdir(), `qoder-unwritable-${crypto.randomUUID()}`, 'machine_id')
  // A file as the parent makes persistence fail without changing local CLI state.
  const parent = path.slice(0, path.lastIndexOf('/'))
  writeFileSync(parent, 'offline')
  try { assert.equal(getMachineId([path]), getMachineId([path])) }
  finally { rmSync(parent) }
})
