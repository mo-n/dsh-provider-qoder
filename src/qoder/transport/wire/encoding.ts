/**
 * Qoder WAF Body encoding algorithm.
 *
 * Re-arranges standard Base64 chunks and translates characters against
 * a custom alphabet to satisfy Qoder upstream WAF requirements.
 *
 * @module dsh-provider-qoder/qoder/transport/wire/encoding
 */

const qoderCustomAlphabet = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!'
const qoderStdAlphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

// The input to this table is always standard Base64 (ASCII), including padding.
const qoderEncodeTable = new Uint8Array(128)
for (let i = 0; i < qoderStdAlphabet.length; i++) {
  qoderEncodeTable[qoderStdAlphabet.charCodeAt(i)] = qoderCustomAlphabet.charCodeAt(i)
}
qoderEncodeTable['='.charCodeAt(0)] = '$'.charCodeAt(0)

/** Encode directly into wire bytes without building per-character string ropes. */
export function qoderEncodeBodyBytes(plaintext: string | Buffer): Buffer<ArrayBuffer> {
  const std = Buffer.isBuffer(plaintext) ? plaintext.toString('base64') : Buffer.from(plaintext).toString('base64')
  const n = std.length
  const a = Math.floor(n / 3)
  const out = Buffer.allocUnsafe(n)
  let offset = 0
  const writeRange = (start: number, end: number): void => {
    for (let i = start; i < end; i++) {
      out[offset++] = qoderEncodeTable[std.charCodeAt(i)]
    }
  }
  // Visit the three ranges in wire order; every output byte is initialized.
  writeRange(n - a, n)
  writeRange(a, n - a)
  writeRange(0, a)
  return out
}

export function qoderEncodeBody(plaintext: string | Buffer): string {
  return qoderEncodeBodyBytes(plaintext).toString('latin1')
}
