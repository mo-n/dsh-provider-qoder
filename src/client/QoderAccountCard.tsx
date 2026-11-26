import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import { isEnvironmentCredentialSource } from '../dsh/credential-contract.ts'
import type { QoderAccountInfo, QoderResourcePackage } from '../qoder/account.ts'
import {
  modelsOf,
  regionOf,
  type QoderCredentialInjected,
  type QoderCredentialStatus,
  type QoderModelSettingsSnapshot,
} from './credential-operations.ts'
import { resolveLocalizedText } from './locales.ts'
import { QoderModelCatalog } from './QoderModelCatalog.tsx'
import { QoderFeatureSettings } from './QoderFeatureSettings.tsx'
import css from './QoderCredentialCard.module.css'

export type QoderAccountCardProps = SettingsSectionOwnerProps & QoderCredentialInjected

type CredentialViewState =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'ready'; info: QoderCredentialStatus }

type AccountViewState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; account: QoderAccountInfo; refreshFailed?: boolean }
  | { status: 'failed' }

function formatAccountDate(locale: string, dateStr?: string): string | undefined {
  if (!dateStr) return undefined
  const date = new Date(dateStr)
  if (Number.isNaN(date.getTime())) return undefined
  return date.toLocaleString(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

/**
 * Settings card for the Qoder subscription: credential state, subscriber
 * profile, and every quota block the provider reports. Region changes remount
 * the account state before any old profile can be displayed.
 */
export function QoderAccountCard(props: QoderAccountCardProps) {
  const modelSnapshot = useSyncExternalStore(
    props.operations.subscribeModels,
    props.operations.getModelSnapshot,
    props.operations.getModelSnapshot,
  )
  return <RegionAccountCard key={regionOf(modelSnapshot.value)} {...props} modelSnapshot={modelSnapshot} />
}

function RegionAccountCard({ operations, t, activeLocale, modelSnapshot }: QoderAccountCardProps & {
  modelSnapshot: QoderModelSettingsSnapshot
}) {
  const [credentialState, setCredentialState] = useState<CredentialViewState>({ status: 'loading' })
  const [accountState, setAccountState] = useState<AccountViewState>({ status: 'idle' })
  const [refreshing, setRefreshing] = useState(false)
  const latestAccountRequest = useRef(0)
  const latestCredentialRequest = useRef(0)
  const browserSubscriber = useRef<string | undefined>(undefined)
  useLayoutEffect(() => () => {
    // Invalidate reads at unmount, before late results can publish or clear pending state.
    latestAccountRequest.current++
    latestCredentialRequest.current++
  }, [])

  const loadAccount = useCallback(async (force = false) => {
    const requestId = ++latestAccountRequest.current
    if (force) {
      setRefreshing(true)
      setAccountState(current => current.status === 'ready' ? { ...current, refreshFailed: false } : current)
    } else setAccountState({ status: 'loading' })

    try {
      const result = await operations.getAccount(force)
      if (requestId !== latestAccountRequest.current) return
      if (result?.ok) {
        setAccountState({ status: 'ready', account: result.value })
        return
      }
    } catch {
      // Both RPC failures and exceptions use the localized account status.
    } finally {
      if (requestId === latestAccountRequest.current) setRefreshing(false)
    }
    if (requestId !== latestAccountRequest.current) return
    setAccountState(current => current.status === 'ready' && force
      ? { ...current, refreshFailed: true }
      : { status: 'failed' })
  }, [operations])

  const loadCredential = useCallback(async () => {
    const requestId = ++latestCredentialRequest.current
    setCredentialState({ status: 'loading' })
    const result = await operations.describe()
    if (requestId !== latestCredentialRequest.current) return
    const info = result.ok ? result.value : undefined
    const configured = info?.configured === true && !isEnvironmentCredentialSource(info.source)
    const subscriber = configured ? info.browserSubscriberId : undefined
    // Browser token rotation updates the record without switching subscribers.
    const sameSubscriber = subscriber !== undefined && subscriber === browserSubscriber.current
    browserSubscriber.current = subscriber
    if (!sameSubscriber) {
      latestAccountRequest.current++
      setRefreshing(false)
      if (configured) void loadAccount()
      else setAccountState({ status: 'idle' })
    }
    setCredentialState(info ? { status: 'ready', info } : { status: 'failed' })
  }, [loadAccount, operations])

  useEffect(() => {
    void loadCredential()
    return operations.subscribe(() => { void loadCredential() })
  }, [loadCredential, operations])

  const configured = credentialState.status === 'ready'
    && credentialState.info.configured
    && !isEnvironmentCredentialSource(credentialState.info.source)

  if (credentialState.status === 'loading') {
    return <section className={css.credential}><p>{t('loading')}</p></section>
  }
  if (credentialState.status === 'failed') {
    return (
      <section className={css.credential}>
        <p className={css.error} role="alert">{t('loadFailed')}</p>
        <button type="button" className={css.secondary} onClick={() => { void loadCredential() }}>
          {t('retry')}
        </button>
      </section>
    )
  }

  const locale = activeLocale()
  const formatCredits = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format
  const renderQuota = (
    key: string,
    fallbackLabel: string,
    quota: QoderResourcePackage | undefined,
  ) => {
    if (!quota) return null
    const { total, used, remaining, unit, modelFamilies, modelKeys } = quota
    const title = resolveLocalizedText(quota.title, locale)
    const description = resolveLocalizedText(quota.description, locale)
    const expiresAt = formatAccountDate(locale, quota.expiresAt)
    const hasModelScope = Boolean(modelFamilies?.length || modelKeys?.length)
    const hasBalance = total !== undefined || used !== undefined || remaining !== undefined
    const showAvailable = quota.available === true && !hasBalance
    const label = title ?? fallbackLabel
    let status: string | undefined
    switch (quota.status) {
      case 'QUOTA_DETAIL_STATUS_EXHAUSTED': status = t('quotaStatusExhausted'); break
      case 'QUOTA_DETAIL_STATUS_EXPIRED': status = t('quotaStatusExpired'); break
      case 'QUOTA_DETAIL_STATUS_SUSPENDED': status = t('quotaStatusSuspended'); break
      default: if (quota.available === false) status = t('quotaStatusUnavailable')
    }
    if (!hasBalance && !status && !showAvailable && !title && !description && !expiresAt && !hasModelScope) return null
    const displayUnit = unit.toLowerCase() === 'credits' ? 'Credits' : unit
    const balance = remaining === undefined ? undefined
      : t('quotaRemaining', { value: formatCredits(remaining), unit: displayUnit })
    const usage = used === undefined
      ? (total === undefined ? undefined : t('quotaTotal', { total: formatCredits(total), unit: displayUnit }))
      : (total === undefined
        ? t('quotaUsedOnly', { used: formatCredits(used), unit: displayUnit })
        : t('quotaUsed', { used: formatCredits(used), total: formatCredits(total), unit: displayUnit }))
    return (
      <div className={css.quotaBlock} key={key}>
        <div className={css.quotaHeader}>
          <span className={css.quotaLabel}>{label}</span>
          {status ? <strong className={css.quotaStatus}>{status}</strong> : null}
          {!status && showAvailable ? <span className={css.quotaMeta}>{t('quotaStatusAvailable')}</span> : null}
          {balance ? status ? <span className={css.quotaMeta}>{balance}</span> : <strong>{balance}</strong> : null}
        </div>
        {usage ? <div className={css.quotaTop}>{usage}</div> : null}
        {total !== undefined && total > 0 && used !== undefined ? (
          <progress
            className={css.quotaProgress}
            max={total}
            value={Math.max(0, Math.min(total, used))}
            aria-label={`${label} ${usage}`}
          />
        ) : null}
        {description ? <p className={css.quotaDescription}>{description}</p> : null}
        {expiresAt ? <div className={css.quotaMeta}>{t('dedicatedResourceExpiresAt', { value: expiresAt })}</div> : null}
        {hasModelScope ? (
          <details className={css.quotaModelScope}>
            <summary>{t('quotaModelScope')}</summary>
            {modelFamilies?.length ? <div>{t('quotaModelFamilies', { value: modelFamilies.join(', ') })}</div> : null}
            {modelKeys?.length ? <div>{t('quotaModelKeys', { value: modelKeys.join(', ') })}</div> : null}
          </details>
        ) : null}
      </div>
    )
  }

  const renderAccount = () => {
    if (!configured) {
      return (
        <div className={css.accountSection}>
          <div className={css.accountEmptyText}>{t('accountCredentialHint')}</div>
        </div>
      )
    }
    if (accountState.status === 'loading') {
      return <div className={css.accountSection}><p className={css.accountLoadingText}>{t('accountLoading')}</p></div>
    }
    if (accountState.status === 'failed') {
      return (
        <div className={css.accountSection}>
          <div className={css.accountHead}>
            <span className={css.error}>{t('accountFailed')}</span>
            <button type="button" className={css.refreshBtn} onClick={() => { void loadAccount(true) }}>
              {t('retry')}
            </button>
          </div>
        </div>
      )
    }
    if (accountState.status !== 'ready') return null

    const { profile, usage, plan, updatedAt } = accountState.account
    const avatarInitial = (profile.name || profile.email || 'Q').charAt(0).toUpperCase()
    const planExpiry = formatAccountDate(locale, plan?.endDate)
    const lastUpdated = formatAccountDate(locale, updatedAt)
    const isSuspended = plan?.organization?.isSuspended === true
    const quotaBlocks = [
      renderQuota('userQuota', t('userQuotaTitle'), usage?.userQuota),
      renderQuota('addOnQuota', t('addOnQuotaTitle'), usage?.addOnQuota),
      renderQuota('orgResource', t('orgResourceTitle'), usage?.orgResourcePackage),
      ...(usage?.dedicatedResourcePackages ?? []).map((pkg, index) => renderQuota(
        `dedicatedResource-${pkg.id ?? index}`,
        t('dedicatedResourceTitle'),
        pkg,
      )),
    ].filter(Boolean)
    return (
      <div className={css.accountSection}>
        {isSuspended ? (
          <div className={css.suspendedBanner} role="alert">
            <span>{t('accountSuspended')}</span>
          </div>
        ) : null}
        <div className={css.accountHead}>
          <div className={css.userInfo}>
            <div className={css.avatar} aria-hidden="true">{avatarInitial}</div>
            <div className={css.userDetails}>
              <div className={css.userNameRow}>
                <span className={css.userName}>{profile.name || 'Qoder Subscriber'}</span>
                {plan?.planTierName ? (
                  <span className={css.planBadge}>
                    {plan.planTierName}
                  </span>
                ) : null}
              </div>
              {profile.email ? <span className={css.userEmail}>{profile.email}</span> : null}
              {planExpiry ? <span className={css.quotaMeta}>{t('planExpiresAt', { value: planExpiry })}</span> : null}
              {plan?.organization?.orgName ? (
                <span className={css.orgTag}>
                  {t('organization', { name: plan.organization.orgName })}
                </span>
              ) : null}
            </div>
          </div>
          <button
            type="button"
            className={css.refreshBtn}
            disabled={refreshing}
            onClick={() => { void loadAccount(true) }}
          >
            {refreshing ? t('refreshing') : (accountState.refreshFailed ? t('retry') : t('refresh'))}
          </button>
        </div>
        {accountState.refreshFailed ? (
          <div className={css.accountRefreshStatus} role="status">
            <span className={css.error}>{t('accountRefreshFailed')}</span>
            {lastUpdated ? <time className={css.quotaMeta} dateTime={updatedAt}>{t('accountLastUpdated', { value: lastUpdated })}</time> : null}
          </div>
        ) : null}
        {usage?.isQuotaExceeded ? <p className={css.error} role="status">{t('quotaExceeded')}</p> : null}
        {quotaBlocks.length ? quotaBlocks : <p className={css.accountEmptyText}>{t('noQuota')}</p>}
      </div>
    )
  }

  const currentRegion = regionOf(modelSnapshot.value)
  const currentModels = modelsOf(modelSnapshot.value, currentRegion)
  const canModifyModels = modelSnapshot.status === 'ready' && modelSnapshot.writable

  const renderModelCatalogSection = () => {
    return (
      <details className={css.customized}>
        <summary className={css.customizedSummary}>
          <span>{t('modelsTitle')}</span>
          <span className={css.modelSummaryBadge}>
            {t('modelsEnabled', { count: currentModels.filter(model => model.enabled !== false).length })}
          </span>
        </summary>
        <div className={css.customizedBody}>
          {modelSnapshot.status === 'loading'
            ? <p className={css.hint}>{t('modelsLoading')}</p>
            : modelSnapshot.status === 'unavailable'
              ? <p className={css.error}>{t('modelsUnavailable')}</p>
              : (
                <QoderModelCatalog
                  region={currentRegion}
                  operations={operations}
                  models={currentModels}
                  disabled={!canModifyModels}
                  fetchDisabled={!configured}
                  hideTitle
                  t={t}
                />
              )}
        </div>
      </details>
    )
  }

  return (
    <section className={css.credential} aria-label={t('accountTitle')}>
      <div className={css.head}>
        <h2 className={css.heading}>{t('accountTitle')}</h2>
        <span className={configured ? `${css.status} ${css.configured}` : css.status}>
          {configured ? t('configured') : t('missing')}
        </span>
      </div>
      {renderAccount()}
      <QoderFeatureSettings operations={operations} snapshot={modelSnapshot} t={t} />
      {renderModelCatalogSection()}
    </section>
  )
}
