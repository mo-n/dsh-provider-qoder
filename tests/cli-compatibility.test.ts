/** Frozen samples from the supplied CLI WASM; no CLI binary or network is used. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { ToolCallId, createAssistantMessage, createToolResultMessage, createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { createQoderTransport } from '../src/qoder/transport/index.ts'
import { qoderEncodeBody, qoderEncodeBodyBytes } from '../src/qoder/transport/wire/encoding.ts'
import type { QoderImageAttachments } from '../src/qoder/transport/wire/translate.ts'
import type { QoderWireMessage } from '../src/qoder/transport/wire/wire-types.ts'
import { qoderIdeVersion } from '../src/qoder/transport/wire/cosy.ts'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/qoder-cli.json', import.meta.url), 'utf8')) as {
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
    assert.deepEqual(qoderEncodeBodyBytes(plaintext), Buffer.from(encoded, 'utf8'))
    assert.deepEqual(qoderEncodeBodyBytes(Buffer.from(plaintext)), Buffer.from(encoded, 'utf8'))
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
          assert.equal(headers.get(key), value, key)
        }
        assert.equal(headers.get('Cosy-Version'), qoderIdeVersion)
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

// Tool images stay inside their tool message without synthetic user messages.
for (const publication of [true, false]) {
  test(`model transport preserves tool images with ${publication ? 'published URLs' : 'inline fallback'}`, async () => {
    const image = { attachmentId: 'sha256:tool-image' as never, mediaType: 'image/png' as const, bytes: 3, width: 1, height: 1 }
    const attachments: QoderImageAttachments = {
      imageLimits: {
        maxImageBytes: 1024, maxImagesPerMessage: 20, maxMessageImageBytes: 2048,
        maxImagePixels: 100, maxImageDimension: 10, mediaTypes: ['image/png'],
      },
      async readImageRequest(attachment) {
        return {
          attachment, variantId: 'sha256:tool-variant' as never, data: new Uint8Array([1, 2, 3]),
          mediaType: 'image/png', bytes: 3, width: 1, height: 1, depth: 'uchar', space: 'srgb', hasAlpha: true,
        }
      },
    }
    let chatCalls = 0
    const transport = createQoderTransport({
      region: 'global', attachments, resolvePat: async () => 'pt-offline', resolveMachineId: () => 'offline-machine',
      fetch: (async (input, init) => {
        const url = String(input)
        if (url.includes('/exchange')) return new Response(JSON.stringify({ token: 'jt-offline' }))
        if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'offline-user' }))
        if (url.includes('/image/upload')) return publication
          ? new Response(JSON.stringify({ result: { oss_url: 'https://oss.qoder.sh/tool.png' } }))
          : new Response('', { status: 503 })
        assert.match(url, /agent_chat_generation/)
        const body = decodeBody(init?.body as Uint8Array)
        const messages = body.messages as QoderWireMessage[]
        assert.deepEqual(messages.map(message => message.role), ['user', 'assistant', 'tool'])
        const part = { type: 'image_url', image_url: { url: publication ? 'https://oss.qoder.sh/tool.png' : 'data:image/png;base64,AQID' } }
        assert.deepEqual(messages.slice(2), [
          { role: 'tool', tool_call_id: 'c0', content: [part] },
        ])
        chatCalls++
        return new Response('data: [DONE]\n\n')
      }) as typeof fetch,
    })
    const callId = ToolCallId('c0')
    const request: GenerateOptions = {
      provider: 'dsh-provider-qoder', model: 'vision',
      messages: [
        createUserMessage({ content: [{ type: 'text', text: 'Inspect tool images' }], source: { kind: 'user' } }),
        createAssistantMessage({ content: [{ type: 'tool-call', id: callId, name: 'read', arguments: '{}' }], source: { provider: 'dsh-provider-qoder', model: 'vision' } }),
        createToolResultMessage({ callId, content: [{ type: 'image', attachment: image }], isError: false }),
      ],
    }
    for await (const _chunk of transport.stream(request, { id: 'vision', name: 'Vision', supportsImages: true })) continue
    assert.equal(chatCalls, 1)
  })
}
