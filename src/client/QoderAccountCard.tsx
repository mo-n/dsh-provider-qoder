import { useCallback, useEffect, useRef, useState } from 'react'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import { isEnvironmentCredentialSource } from '../dsh/credential-contract.ts'
import type { QoderAccountInfo, QoderQuota } from '../qoder/account.ts'
import type { QoderCredentialInjected, QoderCredentialStatus } from './credential-operations.ts'
import css from './QoderCredentialCard.module.css'

export type QoderAccountCardProps = SettingsSectionOwnerProps & QoderCredentialInjected

type CredentialViewState =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'ready'; info: QoderCredentialStatus }

type AccountViewState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; account: QoderAccountInfo }
  | { status: 'failed'; error?: string }

function formatResetDate(dateStr?: string): string | undefined {
  if (!dateStr) return undefined
  const date = new Date(dateStr)
  if (Number.isNaN(date.getTime())) return undefined
  return date.toLocaleString(undefined, {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function QoderAccountCard({ operations, t }: QoderAccountCardProps) {
  const [credentialState, setCredentialState] = useState<CredentialViewState>({ status: 'loading' })
  const [accountState, setAccountState] = useState<AccountViewState>({ status: 'idle' })
  const [refreshing, setRefreshing] = useState(false)
  const [credentialRevision, setCredentialRevision] = useState(0)
  const latestAccountRequest = useRef(0)

  const loadCredential = useCallback(async () => {
    const info = await operations.describe()
    setCredentialState(info === undefined ? { status: 'failed' } : { status: 'ready', info })
  }, [operations])

  const loadAccount = useCallback(async (force = false) => {
    const requestId = ++latestAccountRequest.current
    if (force) setRefreshing(true)
    else setAccountState({ status: 'loading' })

    try {
      const result = await operations.getAccount(force)
      if (requestId !== latestAccountRequest.current) return
      if (result?.ok) setAccountState({ status: 'ready', account: result.data })
      else setAccountState({ status: 'failed', error: result?.error })
    } catch (error) {
      if (requestId !== latestAccountRequest.current) return
      setAccountState({ status: 'failed', error: error instanceof Error ? error.message : String(error) })
    } finally {
      if (requestId === latestAccountRequest.current) setRefreshing(false)
    }
  }, [operations])

  useEffect(() => {
    void loadCredential()
    return operations.subscribe(() => {
      void loadCredential()
      setCredentialRevision(revision => revision + 1)
    })
  }, [loadCredential, operations])

  const configured = credentialState.status === 'ready'
    && credentialState.info.configured
    && !isEnvironmentCredentialSource(credentialState.info.source)

  useEffect(() => {
    if (configured) void loadAccount(false)
    else {
      latestAccountRequest.current++
      setRefreshing(false)
      setAccountState({ status: 'idle' })
    }
  }, [configured, credentialRevision, loadAccount])

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

  const renderQuota = (label: string, quota: QoderQuota | undefined, resetDate?: string) => {
    if (!quota || quota.total <= 0) return null
    const remainingPercent = Math.max(0, Math.min(100, Math.round((quota.remaining / quota.total) * 100)))
    return (
      <div className={css.quotaBlock} key={label}>
        <div className={css.quotaHeader}>
          <span className={css.quotaLabel}>{label}</span>
          <strong>{t('quotaRemaining', { value: remainingPercent })}</strong>
        </div>
        <div className={css.quotaTop}>
          <span>{t('quotaUsed', {
            used: quota.used.toFixed(1),
            total: quota.total.toFixed(1),
            unit: quota.unit,
          })}</span>
        </div>
        <progress
          className={css.quotaProgress}
          max={quota.total}
          value={Math.min(quota.total, quota.used)}
          aria-label={`${label} ${t('quotaRemaining', { value: remainingPercent })}`}
        />
        {resetDate ? <div className={css.quotaMeta}>{t('resetsAt', { value: resetDate })}</div> : null}
      </div>
    )
  }

  const renderAccount = () => {
    if (!configured) return <p className={css.hint}>{t('accountCredentialHint')}</p>
    if (accountState.status === 'loading') {
      return <div className={css.accountSection}><p className={css.accountLoadingText}>{t('accountLoading')}</p></div>
    }
    if (accountState.status === 'failed') {
      const detail = accountState.error ? ` (${accountState.error})` : ''
      return (
        <div className={css.accountSection}>
          <div className={css.accountHead}>
            <span className={css.error}>{t('accountFailed')}{detail}</span>
            <button type="button" className={css.refreshBtn} onClick={() => { void loadAccount(true) }}>
              {t('retry')}
            </button>
          </div>
        </div>
      )
    }
    if (accountState.status !== 'ready') return null

    const { profile, usage } = accountState.account
    const userQuota = usage?.userQuota
    const orgPackage = usage?.orgResourcePackage
    const avatarInitial = (profile.name || profile.email || 'Q').charAt(0).toUpperCase()
    const resetDate = formatResetDate(usage?.expiresAt)
    return (
      <div className={css.accountSection}>
        <div className={css.accountHead}>
          <div className={css.userInfo}>
            <div className={css.avatar} aria-hidden="true">{avatarInitial}</div>
            <div className={css.userDetails}>
              <span className={css.userName}>{profile.name || 'Qoder Subscriber'}</span>
              {profile.email ? <span className={css.userEmail}>{profile.email}</span> : null}
            </div>
          </div>
          <button
            type="button"
            className={css.refreshBtn}
            disabled={refreshing}
            onClick={() => { void loadAccount(true) }}
          >
            {refreshing ? t('refreshing') : t('refresh')}
          </button>
        </div>
        {usage?.isQuotaExceeded ? <p className={css.error}>{t('quotaExceeded')}</p> : null}
        {renderQuota(t('userQuotaTitle'), userQuota, resetDate)}
        {renderQuota(t('orgResourceTitle'), orgPackage, resetDate)}
        {(!userQuota || userQuota.total <= 0) && (!orgPackage || orgPackage.total <= 0)
          ? <p className={css.accountEmptyText}>{t('noQuota')}</p>
          : null}
      </div>
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
    </section>
  )
}
