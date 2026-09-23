/** Bridge legacy settings registration and profile-backed live Config forms. */
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { Config, readConfig, type LiveConfig } from './config.ts'

export function bindQoderSettings(
  owner: Context,
  ctx: Context,
  input: Config | LiveConfig,
  options: { base: Config; validate(value: Config): void },
): { namespace: SettingsNamespace; scope: {
  get(): Config
  update(patch: object): Promise<void>
  watch(listener: () => void | Promise<void>): () => void
} } {
  const settings = ctx.settings as typeof ctx.settings & {
    register?: (namespace: SettingsNamespace, schema: typeof Config, options: { base: Config; validate(value: Config): void }) => {
      get(): Config
      update(patch: object): Promise<void>
      watch(listener: () => void | Promise<void>): () => void
    }
  }
  if (typeof settings.register === 'function') {
    const namespace = 'provider-qoder' as SettingsNamespace
    return { namespace, scope: settings.register(namespace, Config, options) }
  }
  const fiber = owner.fiber as typeof owner.fiber & { entry?: { options: { id: string } } }
  const namespace = (fiber.entry?.options.id ?? 'provider-qoder') as SettingsNamespace
  const get = () => readConfig(input)
  options.validate?.(get())
  // Validate candidates before Loader commits new references.
  ctx.effect(() => owner.on('internal/config', function (_raw, next) {
    const value = next()
    if (this === owner.fiber) options.validate?.(Config(value))
    return value
  }))
  return {
    namespace,
    scope: {
      get,
      update: patch => settings.update(namespace, patch),
      watch: listener => {
        // Older published Cordis types predate this Loader event.
        const on = owner.on.bind(owner) as (event: string, callback: () => void) => () => void
        return ctx.effect(() => on('loader/volatile-update', () => {
          void Promise.resolve().then(listener).catch(error => ctx.emit('internal/error', error))
        }))
      },
    },
  }
}
