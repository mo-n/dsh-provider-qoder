/** Browser contributions for the Qoder account and managed credential. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import { qoderCredentialRef } from '../dsh/credential-contract.ts'
import type { QoderAccountInfo } from '../qoder/account.ts'
import type { QoderCatalogModel } from '../qoder/catalog.ts'
import { QoderAccountCard } from './QoderAccountCard.tsx'
import { QoderCredentialCard } from './QoderCredentialCard.tsx'
import { QoderContextSelect } from './QoderContextSelect.tsx'
import type {
  QoderCredentialOperations,
  QoderCredentialStatus,
  QoderModelSettingsSection,
  QoderModelSettingsSnapshot,
} from './credential-operations.ts'
import { en, zh, type QoderCredentialCopy } from './locales.ts'
import { createSessionTierEvents } from './session-tier-events.ts'
import type { QoderSessionTierSelection } from '../dsh/rpc-channel.ts'
import { createQoderRpcCaller } from './rpc-client.ts'

const localeNamespace = 'settings.qoderCredential'
const settingsNamespace = 'provider-qoder'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.qoderCredential': QoderCredentialCopy
  }
  interface SlotMap {
    'settings.models.footer': { kind: 'list'; scope: 'root'; owner: QoderModelsFooterOwnerProps }
    'conversation.input.right': { kind: 'list'; scope: 'session' }
  }
}

export interface SlotService extends SlotCore {
  inject(name: string, callback: () => unknown): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    slots: SlotService
  }
}

interface QoderModelsFooterOwnerProps {
  children?: never
}

export const inject = ['slots', 'locale', 'remote', 'remote.credentials', 'configForms']

interface ModelForm {
  getSnapshot(): QoderModelSettingsSnapshot
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<boolean | void>
  mutate(ops: readonly SettingsPathOpView[]): Promise<boolean | void>
}

type CredentialRemoteResponse<T> =
  | { ok: true; value: T }
  | { ok: false; error: { message: string } }

interface QoderCredentialsRemote {
  describe(refs: string[]): Promise<CredentialRemoteResponse<Record<string, QoderCredentialStatus>>>
  set(ref: string, value: string): Promise<CredentialRemoteResponse<unknown>>
  unset(ref: string): Promise<CredentialRemoteResponse<unknown>>
}

const fill = (text: string, values?: Record<string, string | number>): string => {
  if (!values) return text
  return Object.entries(values).reduce(
    (next, [key, value]) => next.replace(new RegExp(`\\{${key}\\}`, 'g'), String(value)),
    text,
  )
}

export function apply(ctx: ClientContext): void {
  mount(ctx, ctx.configForms.get<QoderModelSettingsSection>(settingsNamespace))
}

function mount(ctx: ClientContext, modelScope: ModelForm): void {
  ctx.effect(() => ctx.locale.register(localeNamespace, { zh, en }), 'provider-qoder: credential copy')

  // The released rc.2 declarations predate this generated Remote namespace;
  // the current DSH client exposes it through the same runtime assembly.
  const credentials = (ctx.remote as unknown as { credentials: QoderCredentialsRemote }).credentials
  const rpc = createQoderRpcCaller()
  const tierEvents = createSessionTierEvents()
  ctx.effect(() => () => tierEvents.dispose(), 'provider-qoder: session context tier events')

  const readModelSnapshot = () => modelScope.getSnapshot()
  const operations: QoderCredentialOperations = {
    describe: async () => {
      try {
        const response = await credentials.describe([qoderCredentialRef])
        return response.ok ? response.value[qoderCredentialRef] : undefined
      } catch {
        return undefined
      }
    },
    store: async (value) => {
      try {
        const response = await credentials.set(qoderCredentialRef, value.trim())
        return response.ok
      } catch {
        return false
      }
    },
    remove: async () => {
      try {
        const response = await credentials.unset(qoderCredentialRef)
        return response.ok
      } catch {
        return false
      }
    },
    getAccount: async (force) => await rpc.call<QoderAccountInfo>('account', { force }),
    getModelSnapshot: readModelSnapshot,
    subscribeModels: listener => modelScope.subscribe(listener),
    storeModels: async (region, models) => {
      try {
        // Persist only this region, using the JSON-shaped settings mutation contract.
        const clonedModels = JSON.parse(JSON.stringify(models))
        const res = await modelScope.mutate([{
          op: 'set', path: ['modelsByRegion', region], value: clonedModels,
        }])
        return res !== false
      } catch {
        return false
      }
    },
    storeRegion: async (region) => {
      try {
        return await modelScope.set('region', region) !== false
      } catch {
        return false
      }
    },
    storeWebSearchMode: async (mode) => {
      try {
        return await modelScope.set('webSearchMode', mode) !== false
      } catch {
        return false
      }
    },
    discoverModels: async () => await rpc.call<QoderCatalogModel[]>('models', {}),
    setSessionTier: async (sessionId: string, modelId: string, tierKey: string, region) => {
      try {
        const res = await rpc.call<QoderSessionTierSelection>('sessionTier', { sessionId, modelId, tierKey, region })
        return res.ok ? res.value : undefined
      } catch {
        return undefined
      }
    },

    readSessionTier: async scope => {
      const result = await rpc.call<QoderSessionTierSelection>('readSessionTier', scope)
      return result.ok ? result.value : undefined
    },
    subscribeSessionTiers: (scope, listener) => tierEvents.subscribe(scope, listener),

    subscribe: (listener) => ctx.remote.$on('credentials/reference-updated', (ref: string) => {
      if (ref === qoderCredentialRef) listener()
    }),
  }
  const rawT = ctx.locale.bind(localeNamespace) as (key: QoderCredentialCopy) => string
  const t = (key: QoderCredentialCopy, values?: Record<string, string | number>): string => {
    const raw = rawT(key)
    return fill(raw, values)
  }
  /**
   * Read the live UI locale. Cards call this during render, so a language
   * switch re-resolves provider copy instead of reusing a setup-time snapshot.
   */
  const activeLocale = (): string => ctx.locale.getLocale().active

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'qoder',
    order: 15,
    label: () => t('nav'),
    locale: localeNamespace,
    inject: () => ({ operations, t, activeLocale }),
  }, QoderAccountCard))
  ctx.slots.inject('settings.models.footer', () => ctx.slots.register({
    name: 'settings.models.footer',
    id: 'qoder-credential',
    order: 15,
    inject: () => ({ operations, t, activeLocale }),
  }, QoderCredentialCard))
  // Bind the control to the live model-directory service and its session faces.
  // A setup-time optional lookup does not follow service readiness or replacement.
  ctx.inject(['modelDirectories', 'sessions', 'remote.session'], (scope: ClientContext) => {
    scope.slots.inject('conversation.input.right', () => scope.slots.register({
      name: 'conversation.input.right',
      id: 'qoder-context-select',
      order: 10,
      inject: (sessionId: string) => {
        let directory: unknown = undefined
        try {
          const modelDirectories = scope.get('modelDirectories') as {
            directoryFor(id: string): { store: unknown }
          } | undefined
          directory = sessionId && modelDirectories ? modelDirectories.directoryFor(sessionId)?.store : undefined
        } catch {
          // directoryFor resolution may throw if session scope is not ready yet
        }
        return {
          sessionId,
          directory,
          operations,
          t,
          activeLocale,
        }
      },
    }, QoderContextSelect))
  })
}
