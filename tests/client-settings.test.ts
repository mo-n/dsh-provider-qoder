import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'

for (const service of ['settingsScope', 'configForms']) {
  test(`client settings mount through ${service} and report rejected writes`, async () => {
    let plugin!: { apply(ctx: unknown): void; inject: string[] }
    const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
    runInNewContext(source, {
      window: { __ModuleLoader__: { load: ({ factory }: { factory: (require: unknown) => typeof plugin }) => {
        plugin = factory(createRequire(import.meta.url))
      } } },
      fetch: async () => { throw new Error('Unexpected network request') },
    })
    let namespace: string | undefined
    let operations!: {
      storeRegion(region: string): Promise<boolean>
      storeModels(region: string, models: unknown[]): Promise<boolean>
      storeWebSearchMode(mode: string): Promise<boolean>
    }
    let accepted: boolean | undefined
    const writes: unknown[] = []
    const form = {
      getSnapshot: () => ({ value: { modelsByRegion: {} } }),
      subscribe: () => () => {},
      set: async (field: string, value: unknown) => { writes.push([field, value]); return accepted },
    }
    const ctx = {
      inject: (names: string[], mount: (ctx: unknown) => void) => { if (names[0] === service) mount(ctx) },
      effect: (callback: () => unknown) => callback(),
      locale: { register() {}, bind: () => (key: string) => key },
      remote: { credentials: {} },
      settingsScope: { bind: (spec: { namespace: string }) => { namespace = spec.namespace; return form } },
      configForms: { get: (id: string) => { namespace = id; return form } },
      slots: {
        inject: (_name: string, callback: () => void) => callback(),
        register: (spec: { inject(): { operations: typeof operations } }) => { operations = spec.inject().operations },
      },
    }
    plugin.apply(ctx)
    assert.equal(namespace, 'provider-qoder')
    assert.equal(await operations.storeRegion('china'), true)
    accepted = false
    assert.equal(await operations.storeRegion('global'), false)
    assert.equal(await operations.storeModels('china', []), false)
    assert.equal(await operations.storeWebSearchMode('disabled'), false)
    assert.equal(writes.length, 4)
  })
}
