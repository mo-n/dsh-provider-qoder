import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'

const loadClientPlugin = async () => {
  let plugin!: { apply(ctx: unknown): void; inject: string[] }
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  runInNewContext(source, {
    console,
    window: {
      __ModuleLoader__: {
        load: ({ factory }: { factory: (require: unknown) => typeof plugin }) => {
          plugin = factory(createRequire(import.meta.url))
        },
      },
    },
    fetch: async () => {
      throw new Error('Unexpected network request')
    },
  })
  return plugin
}

test('client settings declares base services and omits version-pinned forms from static inject', async () => {
  const plugin = await loadClientPlugin()
  assert.deepEqual([...plugin.inject], ['slots', 'locale', 'remote', 'remote.credentials'])
})

for (const service of ['settingsScope', 'configForms'] as const) {
  test(`client settings mounts through ${service} and reports rejected writes`, async () => {
    const plugin = await loadClientPlugin()
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
      set: async (field: string, value: unknown) => {
        writes.push([field, value])
        return accepted
      },
    }
    const serviceInstance = service === 'settingsScope'
      ? { bind: (spec: { namespace: string }) => { namespace = spec.namespace; return form } }
      : { get: (id: string) => { namespace = id; return form } }

    const ctx = {
      get: (name: string) => (name === service ? serviceInstance : undefined),
      effect: (callback: () => unknown) => callback(),
      locale: { register() {}, bind: () => (key: string) => key },
      remote: { credentials: {} },
      slots: {
        inject: (_name: string, callback: () => void) => callback(),
        register: (spec: { inject(): { operations: typeof operations } }) => {
          operations = spec.inject().operations
        },
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

test('client settings does not access undeclared properties directly on dynamic guarded context', async () => {
  const plugin = await loadClientPlugin()
  const declared = new Set(plugin.inject)
  let mounted = false
  const form = {
    getSnapshot: () => ({ value: { modelsByRegion: {} } }),
    subscribe: () => () => {},
    set: async () => true,
  }
  const rawCtx = {
    get: (name: string) => (name === 'settingsScope' ? { bind: () => { mounted = true; return form } } : undefined),
    effect: (callback: () => unknown) => callback(),
    locale: { register() {}, bind: () => (key: string) => key },
    remote: { credentials: {} },
    slots: {
      inject: (_name: string, callback: () => void) => callback(),
      register: () => {},
    },
  }
  // Simulate cordis-client-runner dynamicCordisContext: undeclared property access throws
  const guardedCtx = new Proxy(rawCtx, {
    get(target, prop, receiver) {
      if (prop === 'get') return Reflect.get(target, prop, receiver)
      if (typeof prop === 'string' && !declared.has(prop) && !(prop in rawCtx)) {
        throw new Error(`dynamic ctx does not expose "${prop}"`)
      }
      return Reflect.get(target, prop, receiver)
    },
  })
  assert.doesNotThrow(() => {
    plugin.apply(guardedCtx)
  })
  assert.equal(mounted, true)
})

test('client settings degrades gracefully without throwing when neither config service is present on guarded context', async () => {
  const plugin = await loadClientPlugin()
  const declared = new Set(plugin.inject)
  const rawCtx = {
    get: () => undefined,
    effect: (callback: () => unknown) => callback(),
    locale: { register() {}, bind: () => (key: string) => key },
    remote: { credentials: {} },
    slots: {
      inject: (_name: string, callback: () => void) => callback(),
      register: () => {},
    },
  }
  // Simulate cordis-client-runner dynamicCordisContext: undeclared property access throws
  const guardedCtx = new Proxy(rawCtx, {
    get(target, prop, receiver) {
      if (prop === 'get') return Reflect.get(target, prop, receiver)
      if (typeof prop === 'string' && !declared.has(prop) && !(prop in rawCtx)) {
        throw new Error(`dynamic ctx does not expose "${prop}"`)
      }
      return Reflect.get(target, prop, receiver)
    },
  })
  const warnings: unknown[][] = []
  const originalWarn = console.warn
  console.warn = (...args: unknown[]) => { warnings.push(args) }
  try {
    assert.doesNotThrow(() => {
      plugin.apply(guardedCtx)
    })
    assert.equal(warnings.length, 1)
    assert.match(String(warnings[0][0]), /neither configForms nor settingsScope/i)
  } finally {
    console.warn = originalWarn
  }
})

