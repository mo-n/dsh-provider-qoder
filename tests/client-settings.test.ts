import type { OperationResult } from '../src/client/operation-result.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { Context, Service } from '@deepseek-ai/cordis'

const loadClientPlugin = async (send: typeof fetch = async () => { throw new Error('Unexpected network request') }) => {
  let plugin!: { apply(ctx: unknown): void; inject: string[] }
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  runInNewContext(source, {
    console,
    window: {
      __ModuleLoader__: {
        load: ({ factory }: { factory: (require: unknown) => typeof plugin }) => {
          const require = createRequire(import.meta.url)
          // DSH's browser shell supplies this static shared module. Node does not load its CSS entry.
          plugin = factory((id: string) => id === '@deepseek-ai/dsh-client-ui-primitives'
            ? { TextShimmer: () => null, IconQueueOutlineRegular: () => null, Input: () => null } : require(id))
        },
      },
    },
    fetch: send,
  })
  return plugin
}

test('client settings declares required services', async () => {
  const plugin = await loadClientPlugin()
  assert.deepEqual([...plugin.inject], ['slots', 'locale', 'remote', 'remote.credentials', 'configForms'])
})

test('client settings mounts with declared services and reports rejected writes', async () => {
  const plugin = await loadClientPlugin()
  let namespace: string | undefined
  let operations!: {
    storeRegion(region: string): Promise<OperationResult<void>>
    storeModels(region: string, models: unknown[]): Promise<OperationResult<void>>
    storeWebSearchMode(mode: string): Promise<OperationResult<void>>
    storeImageSearchEnabled(enabled: boolean): Promise<OperationResult<void>>
    storeImageGenEnabled(enabled: boolean): Promise<OperationResult<void>>
  }
  let accepted: boolean | undefined
  const writes: unknown[] = []
  const registeredSlots: string[] = []
  const form = {
    getSnapshot: () => ({ value: { modelsByRegion: {} } }),
    subscribe: () => () => {},
    set: async (field: string, value: unknown) => {
      writes.push([field, value])
      return accepted
    },
    mutate: async (ops: unknown) => {
      writes.push(ops)
      return accepted
    },
  }
  const ctx = {
    configForms: { get: (id: string) => { namespace = id; return form } },
    effect: (callback: () => unknown) => callback(),
    locale: { register() {}, bind: () => (key: string) => key },
    remote: { credentials: { describe: async () => ({ ok: true, value: {} }), set: async () => ({ ok: true, value: undefined }), unset: async () => ({ ok: true, value: undefined }) } },
    inject: () => {},
    slots: {
      inject: (_name: string, callback: () => void) => callback(),
      register: (spec: { name: string; inject(): { operations: typeof operations } }) => {
        registeredSlots.push(spec.name)
        if (spec.name !== 'conversation.input.dock') operations = spec.inject().operations
      },
    },
  }
  const frameworkApis = new Set(['effect', 'inject'])
  const guardedContext = (declared: ReadonlySet<string>) => new Proxy(ctx, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && !declared.has(prop) && !frameworkApis.has(prop)) {
        throw new Error(`dynamic ctx does not expose "${prop}"`)
      }
      return Reflect.get(target, prop, receiver)
    },
  })
  const declared = new Set(plugin.inject)
  // Existing fake services must still be inaccessible when their declaration is missing.
  const missingConfigForms = new Set(declared)
  missingConfigForms.delete('configForms')
  assert.throws(() => plugin.apply(guardedContext(missingConfigForms)), /dynamic ctx does not expose "configForms"/u)
  const validCredentials = ctx.remote.credentials
  ctx.remote.credentials = {} as typeof validCredentials
  assert.throws(() => plugin.apply(guardedContext(declared)), /require the DSH credentials Remote API/)
  ctx.remote.credentials = validCredentials
  plugin.apply(guardedContext(declared))
  assert.equal(namespace, 'provider-qoder')
  assert.deepEqual(registeredSlots, ['conversation.input.dock', 'settings.section', 'settings.models.footer'])
  assert.equal((await operations.storeRegion('china')).ok, true)
  accepted = false
  assert.equal((await operations.storeRegion('global')).ok, false)
  assert.equal((await operations.storeModels('china', [])).ok, false)
  assert.equal((await operations.storeWebSearchMode('disabled')).ok, false)
  assert.equal((await operations.storeImageSearchEnabled(false)).ok, false)
  assert.equal((await operations.storeImageGenEnabled(false)).ok, false)
  accepted = true
  assert.equal((await operations.storeImageSearchEnabled(true)).ok, true)
  assert.equal((await operations.storeImageGenEnabled(true)).ok, true)
  assert.deepEqual(JSON.parse(JSON.stringify(writes.slice(4))), [
    ['imageSearchEnabled', false], ['imageGenEnabled', false],
    ['imageSearchEnabled', true], ['imageGenEnabled', true],
  ])
  assert.equal(writes.length, 8)
  assert.deepEqual(JSON.parse(JSON.stringify(writes[2])), [{
    op: 'set', path: ['modelsByRegion', 'china'], value: [],
  }])
})

test('new conversation receives the default model directory before a model selection', async () => {
  const plugin = await loadClientPlugin()
  const ctx = new Context()
  const current = { provider: 'dsh-provider-qoder', model: 'dfmodel' }
  const directory = { getSnapshot: () => ({ current }), subscribe: () => () => {} }
  const entries = new Map<string, { inject(sessionId: string): { directory: typeof directory } }>()
  const form = {
    getSnapshot: () => ({ value: { modelsByRegion: {} } }),
    subscribe: () => () => {},
    set: async () => true,
  }
  // Exercise real Cordis service tracing and dependency readiness.
  class ModelDirectories extends Service {
    static inject = ['sessions', 'remote', 'remote.session']

    constructor(scope: Context) {
      super(scope, 'modelDirectories')
    }

    directoryFor(sessionId: string) {
      const sessions = (this.ctx as unknown as { sessions: { has(id: string): boolean } }).sessions
      assert.ok(sessions.has(sessionId))
      assert.ok(this.ctx.remote.session)
      return { store: directory }
    }
  }
  try {
    ctx.provide('slots', {
      inject: (_name: string, callback: () => unknown) => callback(),
      register: (spec: { name: string; inject(sessionId: string): { directory: typeof directory } }) => {
        entries.set(spec.name, spec)
      },
    } as any)
    ctx.provide('locale', { register() {}, bind: () => (key: string) => key } as any)
    ctx.provide('remote', { credentials: { describe: async () => ({ ok: true, value: {} }), set: async () => ({ ok: true, value: undefined }), unset: async () => ({ ok: true, value: undefined }) }, session: {} } as any)
    ctx.provide('remote.credentials', ctx.remote.credentials)
    ctx.provide('configForms', { get: () => form } as any)
    await ctx.plugin(plugin).await()
    assert.ok(entries.has('settings.section'))
    assert.equal(entries.has('conversation.input.right'), false)

    // Services may mount after the settings plugin. The control follows readiness.
    await ctx.plugin({
      apply(scope: Context) {
        scope.provide('sessions', { has: (id: string) => id === 'new' } as any)
        scope.provide('remote.session', {} as any)
      },
    }).await()
    await ctx.plugin(ModelDirectories).await()
    await ctx.fiber.await()
    const entry = entries.get('conversation.input.right')
    assert.ok(entry)
    assert.equal(entry.inject('new').directory, directory)
    assert.deepEqual(entry.inject('new').directory.getSnapshot().current, current)
    assert.equal(entry.inject('not-ready').directory, undefined)
  } finally {
    await ctx.fiber.dispose()
  }
})

for (const authorizationOk of [false, true]) {
  test(`PAT save only succeeds after authorization selection (${authorizationOk})`, async () => {
    const paths: string[] = []
    const plugin = await loadClientPlugin((async (path: string) => {
      paths.push(path)
      return Response.json(path.endsWith('/authorization')
        ? authorizationOk ? { ok: true, value: { method: 'browser' } } : { ok: false, error: { code: 'INTERNAL' } }
        : { ok: true, value: { method: 'pat' } })
    }) as typeof fetch)
    let operations!: { store(value: string): Promise<OperationResult<void>> }
    plugin.apply({
      configForms: { get: () => ({ getSnapshot: () => ({ value: { region: 'global' } }) }) },
      effect: (callback: () => unknown) => callback(),
      locale: { register() {}, bind: () => (key: string) => key },
      remote: { credentials: { set: async () => ({ ok: true }), describe: async () => ({ ok: true, value: {} }), unset: async () => ({ ok: true }) } }, inject() {},
      slots: { inject: (_name: string, callback: () => unknown) => callback(),
        register: (spec: { name: string; inject(): { operations: typeof operations } }) => {
          if (spec.name === 'settings.section') operations = spec.inject().operations
        } },
    })
    assert.equal((await operations.store('synthetic-pat')).ok, authorizationOk)
    assert.equal(paths.some(path => path.endsWith('/selectAuthorization')), authorizationOk)
  })
}
