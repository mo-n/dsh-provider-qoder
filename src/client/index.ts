/** Browser contributions for the Qoder account and managed credential. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import { qoderCredentialRef } from '../credential-contract.ts'
import type { QoderAccountInfo } from '../usage.ts'
import type { QoderCatalogModel } from '../catalog.ts'
import { QoderAccountCard } from './QoderAccountCard.tsx'
import { QoderCredentialCard } from './QoderCredentialCard.tsx'
import type {
  QoderCredentialOperations,
  QoderCredentialStatus,
  QoderModelSettingsSection,
  QoderModelSettingsSnapshot,
} from './credential-operations.ts'
import { en, zh, type QoderCredentialCopy } from './locales.ts'

const localeNamespace = 'settings.qoderCredential'
const qoderChannel = '/qoder-subscription'
const settingsNamespace = 'provider-qoder'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.qoderCredential': QoderCredentialCopy
  }
  interface SlotMap {
    'settings.models.footer': { kind: 'list'; scope: 'root'; owner: QoderModelsFooterOwnerProps }
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

export const inject = ['slots', 'locale', 'remote', 'remote.credentials', 'connection', 'settingsScope']

type CredentialRemoteResponse<T> =
  | { ok: true; value: T }
  | { ok: false; error: { message: string } }

interface QoderCredentialsRemote {
  describe(refs: string[]): Promise<CredentialRemoteResponse<Record<string, QoderCredentialStatus>>>
  set(ref: string, value: string): Promise<CredentialRemoteResponse<unknown>>
  unset(ref: string): Promise<CredentialRemoteResponse<unknown>>
}

export type GetAccountResult =
  | { ok: true; data: QoderAccountInfo }
  | { ok: false; error?: string }

const fill = (text: string, values?: Record<string, string | number>): string => {
  if (!values) return text
  return Object.entries(values).reduce(
    (next, [key, value]) => next.replace(new RegExp(`\\{${key}\\}`, 'g'), String(value)),
    text,
  )
}

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(localeNamespace, { zh, en }), 'provider-qoder: credential copy')

  // The released rc.2 declarations predate this generated Remote namespace;
  // the current DSH client exposes it through the same runtime assembly.
  const credentials = (ctx.remote as unknown as { credentials: QoderCredentialsRemote }).credentials
  const connection = (ctx as ClientContext & { connection: ConnectionHandle }).connection
  const modelScope = ctx.settingsScope.bind<QoderModelSettingsSection>({ namespace: settingsNamespace })

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
    getAccount: async (force) => {
      try {
        const response = await connection.rpc.call(qoderChannel, 'account', { force })
        if (response.ok) {
          return { ok: true, data: response.value as QoderAccountInfo }
        }
        return { ok: false, error: response.error?.message || 'RPC returned error' }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
    getModelSnapshot: () => modelScope.getSnapshot() as QoderModelSettingsSnapshot,
    subscribeModels: listener => modelScope.subscribe(listener),
    storeModels: async (region, models) => {
      try {
        const current = modelScope.getSnapshot().value
        await modelScope.set('modelsByRegion', {
          ...current?.modelsByRegion,
          [region]: models,
        })
        return true
      } catch {
        return false
      }
    },
    storeRegion: async (region) => {
      try {
        await modelScope.set('region', region)
        return true
      } catch {
        return false
      }
    },
    discoverModels: async () => {
      try {
        const response = await connection.rpc.call(qoderChannel, 'models', {})
        if (response.ok) return { ok: true, data: response.value as QoderCatalogModel[] }
        return { ok: false, error: response.error?.message || 'RPC returned error' }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },

    subscribe: (listener) => ctx.remote.$on('credentials/reference-updated', (ref: string) => {
      if (ref === qoderCredentialRef) listener()
    }),
  }
  const rawT = ctx.locale.bind(localeNamespace) as (key: QoderCredentialCopy) => string
  const t = (key: QoderCredentialCopy, values?: Record<string, string | number>): string => {
    const raw = rawT(key)
    return fill(raw, values)
  }

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'qoder',
    order: 15,
    label: () => t('nav'),
    locale: localeNamespace,
    inject: () => ({ operations, t }),
  }, QoderAccountCard))
  ctx.slots.inject('settings.models.footer', () => ctx.slots.register({
    name: 'settings.models.footer',
    id: 'qoder-credential',
    order: 15,
    inject: () => ({ operations, t }),
  }, QoderCredentialCard))
}
