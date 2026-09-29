/** Bind Qoder settings to DSH profile-backed live Config forms. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { Config, readConfig, type LiveConfig } from './config.ts'

export function bindQoderSettings(
  owner: Context,
  ctx: Context,
  input: Config | LiveConfig,
  options: { validate(value: Config): void },
): { namespace: SettingsNamespace; scope: {
  get(): Config
  update(patch: object): Promise<void>
  watch(listener: () => void | Promise<void>): () => void
} } {
  const namespace = (owner.fiber.entry?.options.id ?? 'provider-qoder') as SettingsNamespace
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
      update: patch => ctx.settings.update(namespace, patch),
      watch: listener => {
        return ctx.effect(() => owner.on('loader/volatile-update', () => {
          void Promise.resolve().then(listener).catch(error => ctx.emit('internal/error', error))
        }))
      },
    },
  }
}
