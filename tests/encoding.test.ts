import test from 'node:test'
import assert from 'node:assert/strict'
import { qoderEncodeBody, qoderEncodeBodyBytes } from '../src/qoder/transport/wire/encoding.ts'

// Independent string implementation of the existing wire format.
const standard = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const custom = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!'
function referenceEncode(input: string | Buffer): string {
  const base64 = Buffer.from(input).toString('base64')
  const third = Math.floor(base64.length / 3)
  const reordered = base64.slice(base64.length - third)
    + base64.slice(third, base64.length - third) + base64.slice(0, third)
  return Array.from(reordered, char => char === '=' ? '$' : custom[standard.indexOf(char)]).join('')
}

test('wire bytes match the existing encoding across binary, padding and split boundaries', () => {
  for (const length of [...Array.from({ length: 257 }, (_, i) => i), 1023, 1024, 1025, 4095, 4096, 4097]) {
    const input = Buffer.alloc(length)
    for (let i = 0; i < length; i++) input[i] = (i * 73 + length) & 255
    const expected = referenceEncode(input)
    assert.deepEqual(qoderEncodeBodyBytes(input), Buffer.from(expected), `binary length ${length}`)
    assert.equal(qoderEncodeBody(input), expected, `binary length ${length}`)
    const text = '中文🙂abc'.repeat(length % 31) + 'x'.repeat(length)
    assert.deepEqual(qoderEncodeBodyBytes(text), Buffer.from(referenceEncode(text)), `text length ${length}`)
  }
})

test('large conversation wire bytes round-trip through an independent decoder', () => {
  const messages = Array.from({ length: 160 }, (_, turn) => ({
    role: turn % 2 === 0 ? 'user' : 'assistant',
    content: `turn ${turn}: 中文🙂 tool output `.repeat(100),
  }))
  const input = JSON.stringify({ messages, tools: [{ name: 'read', description: 'read a file' }] })
  const encoded = qoderEncodeBodyBytes(input)
  const reordered = Array.from(encoded.toString('ascii'), char =>
    char === '$' ? '=' : standard[custom.indexOf(char)]).join('')
  const n = reordered.length
  const third = Math.floor(n / 3)
  const base64 = reordered.slice(n - third) + reordered.slice(third, n - third) + reordered.slice(0, third)
  assert.deepEqual(Buffer.from(base64, 'base64'), Buffer.from(input))
  assert.deepEqual(Buffer.from(qoderEncodeBody(input)), encoded)
})
