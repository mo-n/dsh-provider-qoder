/** Browser contributions for the Qoder account and managed credential. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import { qoderCredentialRef } from '../dsh/credential-contract.ts'
import type { QoderAccountInfo } from '../qoder/account.ts'
import type { QoderCatalogModel } from '../qoder/catalog.ts'
import { QoderQueueStatus } from './QoderQueueStatus.tsx'
import { QoderAccountCard } from './QoderAccountCard.tsx'
import { QoderCredentialCard } from './QoderCredentialCard.tsx'
import { QoderContextSelect } from './QoderContextSelect.tsx'
import { regionOf } from './credential-operations.ts'
import type { QoderAuthorizationView } from '../qoder/authorization.ts'
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
    'conversation.input.dock': { kind: 'list'; scope: 'session' }
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
  const authorizationOperations = {
    read: (region: import('../qoder/region.ts').QoderRegion) => rpc.call<QoderAuthorizationView>('authorization', { region }),
    begin: (region: import('../qoder/region.ts').QoderRegion) => rpc.call<QoderAuthorizationView>('beginLogin', { region }),
    cancel: (region: import('../qoder/region.ts').QoderRegion) => rpc.call<QoderAuthorizationView>('cancelLogin', { region }),
    select: (region: import('../qoder/region.ts').QoderRegion, method: 'pat' | 'browser' | 'none') => rpc.call<QoderAuthorizationView>('selectAuthorization', { region, method }),
  }
  const operations: QoderCredentialOperations = {
    authorization: authorizationOperations,
    describe: async () => {
      const result = await authorizationOperations.read(regionOf(readModelSnapshot().value))
      return result.ok ? { configured: result.value.configured && !result.value.expired,
        source: result.value.method, writable: result.value.writable } : undefined
    },
    describePat: async () => {
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
        if (response.ok) {
          const region = regionOf(readModelSnapshot().value)
          const current = await authorizationOperations.read(region)
          if (current.ok && current.value.method !== 'pat') return (await authorizationOperations.select(region, 'pat')).ok
        }
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
    storeModelTransport: async (mode) => {
      try {
        return await modelScope.set('modelTransport', mode) !== false
      } catch {
        return false
      }
    },
    discoverModels: async () => await rpc.call<QoderCatalogModel[]>('models', {}),
    setSessionTier: async (sessionId: string, modelId: string, tierKey: string, region) => {
      const scope = { sessionId, modelId, tierKey, region }
      try {
        const res = await rpc.call<QoderSessionTierSelection>('sessionTier', scope)
        if (!res.ok) console.error('[Qoder context tier] Failed to save selection', { ...scope, error: res.error })
        return res.ok ? res.value : undefined
      } catch (error) {
        console.error('[Qoder context tier] Failed to save selection', { ...scope, error })
        return undefined
      }
    },

    readSessionTier: async scope => {
      try {
        const result = await rpc.call<QoderSessionTierSelection>('readSessionTier', scope)
        if (!result.ok) console.error('[Qoder context tier] Failed to read selection', { ...scope, error: result.error })
        return result.ok ? result.value : undefined
      } catch (error) {
        console.error('[Qoder context tier] Failed to read selection', { ...scope, error })
        return undefined
      }
    },
    subscribeSessionTiers: (scope, listener) => tierEvents.subscribe(scope, listener),

    subscribe: listener => {
      const reference = ctx.remote.$on('credentials/reference-updated', (ref: string) => {
        if (ref === qoderCredentialRef) listener()
      })
      const record = ctx.remote.$on('credentials/record-updated', (key: string) => {
        if (key === `provider-qoder/${regionOf(readModelSnapshot().value)}`) listener()
      })
      return () => { reference(); record() }
    },
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

  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: 'qoder-model-queue', order: 30,
    locale: localeNamespace,
    inject: (sessionId: string) => ({ sessionId, rpc, t }),
  }, QoderQueueStatus))
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
