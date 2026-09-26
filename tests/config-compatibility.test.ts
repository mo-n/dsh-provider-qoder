import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

for (const supportsVolatile of [false, true]) {
  test(`packaged plugin imports with volatile schemas ${supportsVolatile ? 'available' : 'unavailable'}`, () => {
    // Isolate the legacy capability simulation from all other schema consumers.
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict'
      import z from '@deepseek-ai/schemastery'
      if (!${supportsVolatile}) delete z.prototype.volatile
      const plugin = await import('./lib/index.js')
      const input = plugin.Config({ region: 'china' })
      assert.equal(typeof input.get === 'function', ${supportsVolatile})
      const value = typeof input.get === 'function' ? input.get() : input
      assert.equal(value.region, 'china')
      assert.equal(value.preserveThinking, true)
      console.log('loaded')
    `], { cwd: new URL('..', import.meta.url), encoding: 'utf8' })
    assert.equal(output.trim(), 'loaded')
  })
}
