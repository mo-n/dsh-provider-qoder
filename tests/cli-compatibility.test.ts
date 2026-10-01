/** Frozen samples from the supplied CLI WASM; no CLI binary or network is used. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { createQoderTransport } from '../src/qoder/transport/index.ts'
import { qoderEncodeBody } from '../src/qoder/transport/wire/encoding.ts'
import { qoderIdeVersion } from '../src/qoder/transport/wire/cosy.ts'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/qoder-cli-1.1.48.json', import.meta.url), 'utf8')) as {
  vectors: Array<{ plaintext: string; encoded: string }>
  infer: { url: string; headers: Record<string, string> }
}

function decodeBody(value: Uint8Array): Record<string, unknown> {
  const custom = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!'
  const standard = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const rearranged = [...Buffer.from(value).toString()].map(char => char === '$' ? '=' : standard[custom.indexOf(char)]).join('')
  const third = Math.floor(rearranged.length / 3)
  const base64 = rearranged.slice(-third) + rearranged.slice(third, -third) + rearranged.slice(0, third)
  return JSON.parse(Buffer.from(base64, 'base64').toString())
}

test('body encoding matches frozen qodercli WASM vectors including UTF-8 and search envelope', () => {
  for (const { plaintext, encoded } of fixture.vectors) {
    assert.equal(qoderEncodeBody(plaintext), encoded)
    assert.equal(qoderEncodeBody(Buffer.from(plaintext)), encoded)
  }
})

for (const region of ['global', 'china'] as const) {
  test(`${region} model requests preserve the CLI header contract and regional session identity`, async () => {
    let seen = false
    const transport = createQoderTransport({
      region, resolvePat: async () => 'pt-offline', resolveMachineId: () => 'offline-machine',
      fetch: (async (input, init) => {
        const url = String(input)
        if (url.includes('/exchange')) {
          const headers = new Headers(init?.headers)
          assert.equal(headers.get('cosy-version'), qoderIdeVersion)
          assert.equal(headers.get('user-agent'), `qoder/${qoderIdeVersion}`)
          assert.equal(headers.get('Cosy-MachineToken'), null)
          return new Response(JSON.stringify({ token: 'jt-offline', expires_in: 3600 }))
        }
        if (url.includes('/userinfo')) return new Response(JSON.stringify({
          id: 'offline-user', organization_id: 'offline-org', organization_tags: ['Security', 'JadeKey'], data_policy_agreed: false,
        }))
        seen = true
        assert.equal(url, region === 'global' ? fixture.infer.url : fixture.infer.url.replace('api3.qoder.sh', 'gateway.qoder.com.cn'))
        const headers = new Headers(init?.headers)
        for (const [key, value] of Object.entries(fixture.infer.headers)) {
          // Keep the audited fixture intact while checking the configured client version.
          assert.equal(headers.get(key), key === 'Cosy-Version' ? qoderIdeVersion : value, key)
        }
        assert.equal(headers.get('Cosy-ClientIp'), null)
        assert.equal(headers.get('Cosy-Sigpath'), null)
        const request = decodeBody(init?.body as Uint8Array)
        assert.equal(request.session_type, region === 'china' ? 'qoderclicn' : 'qodercli')
        assert.equal((request.business as { version: string }).version, qoderIdeVersion)
        assert.deepEqual(request.system, [{ type: 'text', text: 'Offline system' }])
        return new Response('data: [DONE]\n\n')
      }) as typeof fetch,
    })
    const request = {
      provider: 'dsh-provider-qoder', model: 'cmodel', system: 'Offline system',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'Offline' }], source: { kind: 'user' } })],
    } as GenerateOptions
    for await (const _chunk of transport.stream(request)) continue
    assert.equal(seen, true)
  })
}
