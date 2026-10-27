/** Image responses can contain signed URLs, echoed prompts and arbitrary credentials. */
export function inspectImageUrl(raw: string) {
  if (/^data:/iu.test(raw)) {
    const header = /^data:([^;,]+);base64,/iu.exec(raw)
    return { protocol: 'data:', encoding: header ? 'base64' : undefined,
      rejection: !header ? 'INVALID_DATA_URL' : !/^(?:image\/[^;,]+|application\/octet-stream|binary\/octet-stream)$/iu.test(header[1]) ? 'UNSUPPORTED_CONTENT_TYPE' : undefined }
  }
  let url: URL
  try { url = new URL(raw) } catch { return { rejection: 'INVALID_URL' } }
  const rejection = url.protocol !== 'https:' && url.protocol !== 'http:' ? 'UNSUPPORTED_PROTOCOL'
    : url.username || url.password ? 'URL_CREDENTIALS'
      : !url.hostname.includes('.') && !url.hostname.includes(':') ? 'UNQUALIFIED_HOST'
        : /(?:^|\.)(?:localhost|local|internal|test|invalid)$/iu.test(url.hostname) ? 'LOCAL_HOST' : undefined
  // Non-web schemes may put arbitrary content in their hostname or protocol.
  const web = url.protocol === 'https:' || url.protocol === 'http:'
  return {
    rejection,
    protocol: web ? url.protocol : 'other',
    hostname: web ? url.hostname : undefined,
    port: web ? url.port || (url.protocol === 'https:' ? '443' : '80') : undefined,
    hasCredentials: !!(url.username || url.password),
    hasQuery: !!url.search,
    hasFragment: !!url.hash,
  }
}

/** Preserve bounded response structure and scalar status values, never free-form text. */
export function imageResponseDiagnostic(value: unknown): unknown {
  let budget = 100
  const visit = (item: unknown, key: string, depth: number): unknown => {
    if (--budget < 0 || depth > 5) return '[TRUNCATED]'
    if (/(?:auth|credential|password|secret|token|signature|prompt|base64|b64|bytes)/iu.test(key)) return '[REDACTED]'
    if (typeof item === 'string') {
      if (/^(?:url|imageUrl|image_url|ossUrl|link)$/iu.test(key)) return inspectImageUrl(item)
      if (/^(?:code|errorCode|status)$/u.test(key) && /^\d{1,9}$/.test(item)) return item
      return { redacted: true, length: item.length }
    }
    if (item === null || typeof item !== 'object') return item
    if (Array.isArray(item)) return item.slice(0, 10).map(entry => visit(entry, '', depth + 1))
    return Object.fromEntries(Object.entries(item).slice(0, 20).map(([field, entry]) => [
      /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(field) ? field : '[REDACTED_KEY]', visit(entry, field, depth + 1),
    ]))
  }
  return visit(value, '', 0)
}
