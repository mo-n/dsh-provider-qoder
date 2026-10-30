import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'

test('bundle preserves the complete host web configuration', () => {
  const hostConfig = {
    searchProvider: 'ambient',
    fetchProvider: 'custom-fetch',
    futureHostOption: { enabled: true },
  }
  const patches = loadOverlayPatches('dsh', fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)))
  const entries = composeEntries([
    [{ insert: [{ id: 'web', name: '@deepseek-ai/dsh-web', config: hostConfig }] }],
    patches,
  ])
  assert.deepEqual(entries.find(entry => entry.id === 'web')?.config, hostConfig)
})
