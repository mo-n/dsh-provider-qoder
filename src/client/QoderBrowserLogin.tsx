import { useEffect, useRef, useState } from 'react'
import type { QoderAuthorizationView } from '../qoder/authorization.ts'
import type { QoderRegion } from '../qoder/region.ts'
import type { QoderAuthorizationOperations, QoderCredentialInjected } from './credential-operations.ts'
import css from './QoderCredentialCard.module.css'

export function QoderBrowserLogin({ region, operations, t }: {
  region: QoderRegion
  operations: QoderAuthorizationOperations
  t: QoderCredentialInjected['t']
}) {
  const [view, setView] = useState<QoderAuthorizationView>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  const mounted = useRef(false)
  const revision = useRef(0)
  const mutating = useRef(false)
  const attempt = view?.attempt
  const pending = attempt !== undefined && ['waiting', 'verifying', 'saving'].includes(attempt.phase)

  useEffect(() => {
    mounted.current = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      const version = revision.current
      const result = await operations.read(region)
      if (!mounted.current) return
      if (version === revision.current && !mutating.current) {
        if (result.ok) { setView(result.value); setError(false) }
        else setError(true)
      }
      timer = setTimeout(() => { void poll() }, 1500)
    }
    void poll()
    return () => { mounted.current = false; clearTimeout(timer); revision.current++ }
  }, [operations, region])

  const mutate = async (action: 'begin' | 'cancel' | 'pat' | 'browser' | 'none') => {
    if (mutating.current) return
    // Reserve a tab during the click, before awaiting the host RPC.
    const popup = action === 'begin' ? window.open('about:blank', '_blank') : null
    if (popup) popup.opener = null
    const version = ++revision.current
    mutating.current = true
    setBusy(true)
    setError(false)
    try {
      const result = action === 'begin' ? await operations.begin(region)
        : action === 'cancel' ? await operations.cancel(region) : await operations.select(region, action)
      if (!mounted.current || version !== revision.current) { popup?.close(); return }
      if (result.ok) {
        setView(result.value)
        if (popup && result.value.attempt?.url) popup.location.replace(result.value.attempt.url)
        else popup?.close()
      } else { popup?.close(); setError(true) }
    } catch {
      popup?.close()
      if (mounted.current && version === revision.current) setError(true)
    } finally {
      mutating.current = false
      if (mounted.current && version === revision.current) { revision.current++; setBusy(false) }
    }
  }

  return <div className={css.browserLogin} aria-label={t('browserLoginTitle')}>
    <div className={css.credentialRowHead}>
      <strong>{t('browserLoginTitle')}</strong>
      {view ? <span className={css.regionBadge}>{t(view.method === 'browser' ? 'browserMethod' : view.method === 'pat' ? 'patMethod' : 'signedOut')}</span> : null}
    </div>
    <p className={css.label}>{t('sharedAuthorization')}</p>
    {view?.profile ? <p>{view.method !== 'browser' ? `${t('savedBrowserAccount')}: ` : ''}{view.profile.name} · {view.profile.email}</p> : null}
    {view?.expired ? <p role="status" className={css.error}>{t('browserExpired')}</p> : null}
    {view?.unsaved ? <p role="alert" className={css.error}>{t('browserUnsaved')}</p> : null}
    {attempt ? <p role="status">{t(attempt.phase === 'waiting' || attempt.phase === 'verifying' ? 'browserWaiting'
      : attempt.phase === 'saving' ? 'browserSaving' : attempt.phase === 'complete' ? 'browserComplete'
      : attempt.phase === 'timeout' ? 'browserTimeout' : attempt.phase === 'failed' ? 'browserFailed' : 'browserCancelled')}</p> : null}
    {pending && attempt?.url ? <div className={css.actions}>
      <a href={attempt.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{t('openLogin')}</a>
      <button type="button" className={css.secondary} onClick={() => {
        if (!navigator.clipboard) { setCopyFailed(true); return }
        void navigator.clipboard.writeText(attempt.url!).then(
          () => { if (mounted.current) setCopyFailed(false) },
          () => { if (mounted.current) setCopyFailed(true) },
        )
      }}>{t('copyLogin')}</button>
    </div> : null}
    {copyFailed ? <p role="alert" className={css.error}>{t('copyLoginFailed')}</p> : null}
    <div className={css.actions}>
      <button type="button" className={css.primary} disabled={busy || !view?.writable || pending} onClick={() => { void mutate('begin') }}>{t('signInQoder')}</button>
      {pending ? <button type="button" className={css.secondary} disabled={busy || !view?.writable} onClick={() => { void mutate('cancel') }}>{t('cancelLogin')}</button> : null}
      {view?.method !== 'pat' ? <button type="button" className={css.secondary} disabled={busy || !view?.writable} onClick={() => { void mutate('pat') }}>{t('usePat')}</button> : null}
      {view?.profile && view.method !== 'browser' ? <button type="button" className={css.secondary} disabled={busy || !view.writable} onClick={() => { void mutate('browser') }}>{t('useBrowser')}</button> : null}
      {view?.profile ? <button type="button" className={css.danger} disabled={busy || !view.writable} onClick={() => { void mutate('none') }}>{t('signOutQoder')}</button> : null}
    </div>
    {view && !view.writable ? <p className={css.error}>{t('readOnly')}</p> : null}
    {error ? <p role="alert" className={css.error}>{t('browserOperationFailed')}</p> : null}
  </div>
}
