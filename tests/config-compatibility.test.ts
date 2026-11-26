import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, openSync, closeSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

for (const supportsVolatile of [false, true]) {
  test(`packaged plugin imports with volatile schemas ${supportsVolatile ? 'available' : 'unavailable'}`, t => {
    const directory = mkdtempSync(join(tmpdir(), 'qoder-config-test-'))
    t.after(() => rmSync(directory, { recursive: true, force: true }))
    const outputPath = join(directory, 'stdout')
    // File-backed stdout also works where the Windows sandbox denies subprocess pipes.
    const stdout = openSync(outputPath, 'w')
    // Isolate the legacy capability simulation from all other schema consumers.
    const script = `
      import assert from 'node:assert/strict'
      import z from '@deepseek-ai/schemastery'
      // Initialize the supported host dependency before simulating a missing provider capability.
      await import('@deepseek-ai/dsh-web')
      if (!${supportsVolatile}) delete z.prototype.volatile
      const plugin = await import('./lib/index.js')
      const input = plugin.Config({ region: 'china' })
      assert.equal(typeof input.get === 'function', ${supportsVolatile})
      const value = typeof input.get === 'function' ? input.get() : input
      assert.equal(value.region, 'china')
      assert.equal(value.preserveThinking, true)
      assert.equal(value.webSearchMode, 'auto')
      assert.equal(value.imageSearchEnabled, true)
      assert.equal(value.imageGenEnabled, true)
      assert.equal(value.replaceSystemPrompt, true)
      const disabled = plugin.Config({ webSearchMode: 'always', imageSearchEnabled: false, imageGenEnabled: false, replaceSystemPrompt: false })
      const disabledValue = typeof disabled.get === 'function' ? disabled.get() : disabled
      assert.equal(disabledValue.webSearchMode, 'always')
      assert.equal(disabledValue.imageSearchEnabled, false)
      assert.equal(disabledValue.imageGenEnabled, false)
      assert.equal(disabledValue.replaceSystemPrompt, false)
      console.log('loaded')
    `
    try {
      execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: new URL('..', import.meta.url), stdio: ['inherit', stdout, 'inherit'],
      })
    } finally {
      closeSync(stdout)
    }
    assert.equal(readFileSync(outputPath, 'utf8').trim(), 'loaded')
  })
}
