import { useEffect, useRef, useState } from 'react'
import type { QoderAuthorizationView } from '../qoder/authorization.ts'
import type { QoderRegion } from '../qoder/region.ts'
import type { QoderAuthorizationOperations, QoderCredentialInjected, QoderCredentialOperations, QoderCredentialStatus } from './credential-operations.ts'
import type { QoderCredentialCopy } from './locales.ts'
import { isEnvironmentCredentialSource } from '../dsh/credential-contract.ts'
import { operationNotice } from './operation-result.ts'
import css from './QoderCredentialCard.module.css'

export interface QoderBrowserLoginProps {
  region: QoderRegion
  operations?: QoderAuthorizationOperations
  credentials: Pick<QoderCredentialOperations, 'describe' | 'describePat' | 'store' | 'remove' | 'getAccount'> & Partial<Pick<QoderCredentialOperations, 'subscribe'>>
  onBusyChange?(busy: boolean): void
  t: QoderCredentialInjected['t']
}

/** A single current identity, with browser and PAT management revealed only when needed. */
export function QoderBrowserLogin({ region, operations, credentials, onBusyChange, t }: QoderBrowserLoginProps) {
  const [view, setView] = useState<QoderAuthorizationView>()
  const [pat, setPat] = useState<QoderCredentialStatus>()
  const [profile, setProfile] = useState<QoderAuthorizationView['profile']>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<QoderCredentialCopy>()
  const [readFailed, setReadFailed] = useState(false)
  const [editing, setEditing] = useState(false)
  const [menu, setMenu] = useState(false)
  const [draft, setDraft] = useState('')
  const [copyFailed, setCopyFailed] = useState(false)
  const [copied, setCopied] = useState(false)
  const [now, setNow] = useState(Date.now())
  const [accountRevision, setAccountRevision] = useState(0)
  const mounted = useRef(false)
  const revision = useRef(0)
  const mutating = useRef(false)
  const waitingRef = useRef(false)
  const wakeRef = useRef<(() => void) | undefined>(undefined)
  const attempt = view?.attempt
  const pending = attempt !== undefined && ['waiting', 'verifying', 'saving'].includes(attempt.phase)
  const connected = view?.configured === true && !view.expired
  const identity = view?.method === 'browser' ? view.profile : profile
  const patConfigured = pat?.configured === true && !isEnvironmentCredentialSource(pat.source)
  const remaining = Math.max(0, Math.ceil(((attempt?.expiresAt ?? now) - now) / 1000))

  const read = async () => {
    const described = await (credentials.describePat ?? credentials.describe)()
    const info = described.ok ? described.value : undefined
    const result = operations ? await operations.read(region) : undefined
    if (result && !result.ok) throw new Error('Authorization status unavailable')
    if (!result && !info) throw new Error('Credential status unavailable')
    return { info, value: result?.value ?? { region, method: 'pat' as const,
      configured: info?.configured === true && !isEnvironmentCredentialSource(info.source), writable: false } }
  }

  useEffect(() => {
    mounted.current = true
    let active = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async (identityChanged = false) => {
      const version = revision.current
      try {
        const result = await read()
        if (active && mounted.current && version === revision.current && !mutating.current) {
          waitingRef.current = result.value.attempt !== undefined && ['waiting', 'verifying', 'saving'].includes(result.value.attempt.phase)
          setView(result.value); setPat(result.info); setReadFailed(false); setNow(Date.now())
          if (identityChanged) setAccountRevision(value => value + 1)
        }
      } catch { if (mounted.current && version === revision.current) setReadFailed(true) }
      if (active && mounted.current) {
        clearTimeout(timer)
        timer = setTimeout(() => { void poll() }, waitingRef.current ? 1000 : 10_000)
      }
    }
    void poll()
    wakeRef.current = () => { clearTimeout(timer); timer = setTimeout(() => { void poll() }, 1000) }
    const unsubscribe = credentials.subscribe?.(() => {
      if (mutating.current || !active) return
      revision.current++
      setProfile(undefined)
      void poll(true)
    })
    return () => { active = false; mounted.current = false; wakeRef.current = undefined; clearTimeout(timer); unsubscribe?.(); revision.current++ }
  }, [operations, credentials, region])

  useEffect(() => {
    let active = true
    setProfile(undefined)
    if (view?.method === 'pat' && view.configured) {
      const version = revision.current
      void credentials.getAccount().then(result => {
        if (active && version === revision.current && result?.ok) setProfile(result.value.profile)
      }).catch(() => {})
    }
    return () => { active = false }
  }, [credentials, view?.method, view?.configured, accountRevision])

  const mutate = async (action: 'begin' | 'cancel' | 'pat' | 'browser' | 'none' | 'savePat' | 'removePat') => {
    if (mutating.current) return
    const popup = action === 'begin' ? window.open('about:blank', '_blank') : null
    if (popup) popup.opener = null
    const version = ++revision.current
    mutating.current = true
    onBusyChange?.(true)
    setBusy(true); setError(undefined); setMenu(false)
    try {
      let result: Awaited<ReturnType<QoderAuthorizationOperations['read']>> | undefined
      if (action === 'savePat') {
        if (draft.trim()) {
          const saved = await credentials.store(draft.trim())
          if (!saved.ok) {
            if (mounted.current && version === revision.current) {
              setError(operationNotice(saved.error, 'patSaveFailed'))
              if (saved.error.completedStages.includes('persist-pat')) {
                setDraft('')
                // Refresh PAT status so retry selects the saved PAT instead of writing it again.
                const refreshed = await read().catch(() => undefined)
                if (refreshed && mounted.current && version === revision.current) { setView(refreshed.value); setPat(refreshed.info) }
              }
            }
            return
          }
        } else if (patConfigured) {
          if (operations) {
            // A partial save may already have selected PAT despite a lost response.
            const current = await operations.read(region)
            if (!current.ok) {
              if (mounted.current && version === revision.current) setError('operationOutcomeUnknown')
              return
            }
            result = current.value.method === 'pat' ? current : await operations.select(region, 'pat')
          }
        }
        else throw new Error('A PAT is required')
      } else if (action === 'removePat') {
        const removed = await credentials.remove()
        if (!removed.ok) {
          if (mounted.current && version === revision.current) setError(operationNotice(removed.error, 'removeFailed'))
          return
        }
      } else if (operations) {
        result = action === 'begin' ? await operations.begin(region)
          : action === 'cancel' ? await operations.cancel(region) : await operations.select(region, action)
      }
      if (result && !result.ok) {
        if (mounted.current && version === revision.current) {
          const code = result.error.code
          setError(action === 'none' ? 'browserRemoveFailed' : code === 'TIMEOUT' ? 'browserTimeout'
            : code === 'UNAUTHENTICATED' ? 'browserRejected' : 'authorizationConnectionFailed')
        }
        popup?.close()
        return
      }
      const current = result?.value
      if (!mounted.current || version !== revision.current) { popup?.close(); return }
      if (popup && current?.attempt?.url) popup.location.replace(current.attempt.url)
      else popup?.close()
      const refreshed = current ? { value: current, info: pat } : await read()
      if (!mounted.current || version !== revision.current) { popup?.close(); return }
      setView(refreshed.value); setPat(refreshed.info); setReadFailed(false); setNow(Date.now())
      waitingRef.current = refreshed.value.attempt !== undefined && ['waiting', 'verifying', 'saving'].includes(refreshed.value.attempt.phase)
      if (action === 'savePat' || action === 'removePat') {
        setDraft(''); setEditing(false); setProfile(undefined); setAccountRevision(value => value + 1)
      }
    } catch {
      popup?.close()
      if (mounted.current && version === revision.current) setError(action === 'savePat' ? 'patSaveFailed'
        : action === 'removePat' ? 'removeFailed' : action === 'none' ? 'browserRemoveFailed' : 'authorizationConnectionFailed')
    } finally {
      mutating.current = false
      onBusyChange?.(false)
      if (mounted.current && version === revision.current) { revision.current++; setBusy(false) }
      if (mounted.current) wakeRef.current?.()
    }
  }

  const openPat = () => { setMenu(false); setDraft(''); setError(undefined); setEditing(true) }
  const initial = (identity?.name || identity?.email || 'Q').slice(0, 1).toUpperCase()
  const failure = attempt?.phase === 'failed' ? (attempt.failure === 'storage' ? 'browserStorageFailed'
    : attempt.failure === 'connection' ? 'authorizationConnectionFailed' : 'browserRejected') : undefined

  return <div className={css.connectionBody} aria-label={t('accountConnectionTitle')}>
    {!view ? <p role="status">{t(readFailed ? 'authorizationConnectionFailed' : 'loading')}</p> : null}
    {readFailed ? <button type="button" className={css.secondary} onClick={() => wakeRef.current?.()}>{t('retry')}</button> : null}
    {view ? <>
      {connected || view.expired ? <div className={css.subscriberRow}>
        <span className={css.avatar} aria-hidden="true">{initial}</span>
        <div className={css.subscriberIdentity}>
          <strong className={css.userName}>{identity?.name || t(view.method === 'pat' ? 'patActive' : 'browserMethod')}</strong>
          {identity?.email ? <span>{identity.email}</span> : null}
          <span className={css.label}>{t(view.method === 'browser' ? 'browserMethod' : 'patMethod')}</span>
        </div>
        {!pending && !editing ? <button type="button" className={css.secondary} aria-expanded={menu}
          aria-controls="qoder-account-management" disabled={busy}
          onClick={() => setMenu(!menu)}>{t(view.method === 'pat' ? 'manageCredential' : 'manageAccount')}</button> : null}
      </div> : !pending && !editing ? <p className={css.label}>{t('signInDescription')}</p> : null}

      {pending ? <div className={css.loginProgress} role="status">
        <strong>{t(attempt.phase === 'saving' ? 'browserSaving' : 'browserWaiting')}</strong>
        <span className={css.label}>{t('loginTimeRemaining', { seconds: remaining })}</span>
        <div className={css.connectionActions}>
          {attempt.url ? <a className={css.primaryLink} href={attempt.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{t('reopenLogin')}</a> : null}
          <button type="button" className={css.secondary} disabled={busy || !view.writable} onClick={() => { void mutate('cancel') }}>{t('cancelLogin')}</button>
          {attempt.url ? <button type="button" className={css.textButton} onClick={() => {
            if (!navigator.clipboard) { setCopyFailed(true); return }
            void navigator.clipboard.writeText(attempt.url!).then(() => {
              if (mounted.current) { setCopied(true); setCopyFailed(false) }
            }, () => { if (mounted.current) setCopyFailed(true) })
          }}>{t(copied ? 'loginLinkCopied' : 'copyLogin')}</button> : null}
        </div>
      </div> : null}

      {view.expired ? <p role="status" className={css.error}>{t('browserExpired')}</p> : null}
      {view.unsaved ? <p role="alert" className={css.error}>{t('browserUnsaved')}</p> : null}
      {!pending && attempt?.phase === 'timeout' ? <p role="status" className={css.error}>{t('browserTimeout')}</p> : null}
      {!pending && failure ? <p role="alert" className={css.error}>{t(failure)}</p> : null}

      {menu && !pending && !editing ? <div id="qoder-account-management" className={css.managementPanel}>
        <button type="button" className={css.secondary} disabled={busy || !view.writable} onClick={() => { void mutate('begin') }}>{t('changeAccount')}</button>
        <button type="button" className={css.secondary} disabled={busy || !pat?.writable} onClick={openPat}>{t(view.method === 'pat' ? 'editPat' : 'usePat')}</button>
        {view.method !== 'browser' && view.profile ? <button type="button" className={css.secondary} disabled={busy || !view.writable} onClick={() => { void mutate('browser') }}>{t('useBrowser')}</button> : null}
        {view.profile ? <button type="button" className={`${css.textButton} ${css.dangerText}`} disabled={busy || !view.writable} onClick={() => { void mutate('none') }}>{t('signOutQoder')}</button> : null}
      </div> : null}

      {!pending && !editing && (!connected || view.expired) ? <div className={css.connectionActions}>
        <button type="button" className={css.primary} disabled={busy || !view.writable} onClick={() => { void mutate('begin') }}>{t(view.expired ? 'signInAgain' : 'signInQoder')}</button>
        <button type="button" className={css.textButton} disabled={busy || !pat?.writable} onClick={openPat}>{t('usePat')}</button>
        {view.profile && view.method !== 'browser' ? <button type="button" className={css.textButton} disabled={busy || !view.writable} onClick={() => { void mutate('browser') }}>{t('useBrowser')}</button> : null}
      </div> : null}

      {editing ? <div className={css.editor}>
        <label className={css.label} htmlFor="qoder-managed-credential">{t('tokenLabel')}</label>
        <input id="qoder-managed-credential" className={css.input} type="password" autoComplete="new-password" value={draft}
          disabled={busy || !pat?.writable} placeholder={patConfigured ? t('configuredHint') : t('tokenPlaceholder')}
          onChange={event => setDraft(event.currentTarget.value)} />
        <div className={css.connectionActions}>
          <button type="button" className={css.primary} disabled={busy || !pat?.writable || (!draft.trim() && !patConfigured)}
            onClick={() => { void mutate('savePat') }}>{t(busy ? 'saving' : draft.trim() || !patConfigured ? 'saveAndUsePat' : 'useSavedPat')}</button>
          <button type="button" className={css.secondary} disabled={busy} onClick={() => { setDraft(''); setEditing(false); setError(undefined) }}>{t('cancel')}</button>
          {patConfigured ? <button type="button" className={css.danger} disabled={busy || !pat?.writable}
            onClick={() => { if (window.confirm(t('confirmRemove'))) void mutate('removePat') }}>{t('remove')}</button> : null}
        </div>
      </div> : null}
    </> : null}
    {view && !view.writable && !pat?.writable ? <p className={css.label}>{t('readOnly')}</p> : null}
    {copyFailed ? <p role="alert" className={css.error}>{t('copyLoginFailed')}</p> : null}
    {error ? <p role="alert" className={css.error}>{t(error)}</p> : null}
    {readFailed && view ? <p role="alert" className={css.error}>{t('authorizationConnectionFailed')}</p> : null}
  </div>
}
