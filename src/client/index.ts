/** Browser contributions for the Qoder account and managed credential. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import { qoderCredentialRef } from '../dsh/credential-contract.ts'
import { createSettingsOperations, type ModelForm, type QoderCredentialsRemote } from './settings-operations.ts'
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
  QoderModelSettingsSection,
} from './credential-operations.ts'
import { en, zh, type QoderCredentialCopy } from './locales.ts'
import { createSessionTierEvents } from './session-tier-events.ts'
import { createQoderRpcCaller } from './rpc-client.ts'
import { installQoderSettingsNavIcon } from './settings-nav-icon.ts'

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
    ...createSettingsOperations(credentials, modelScope, authorizationOperations, rpc),
    getAccount: async (force) => await rpc.call<QoderAccountInfo>('account', { force }),
    getModelSnapshot: readModelSnapshot,
    subscribeModels: listener => modelScope.subscribe(listener),
    discoverModels: async () => await rpc.call<QoderCatalogModel[]>('models', {}),
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
  installQoderSettingsNavIcon(ctx, () => t('nav'))

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
