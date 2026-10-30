import { useRef, useState, useSyncExternalStore } from 'react'
import type { QoderRegion } from '../qoder/region.ts'
import { regionOf, type QoderCredentialInjected } from './credential-operations.ts'
import { QoderBrowserLogin } from './QoderBrowserLogin.tsx'
import { operationNotice } from './operation-result.ts'
import type { QoderCredentialCopy } from './locales.ts'
import css from './QoderCredentialCard.module.css'

export type QoderCredentialCardProps = QoderCredentialInjected

/** Region selection stays outside the keyed account state, so old identities never flash. */
export function QoderCredentialCard({ operations, t }: QoderCredentialCardProps) {
  const snapshot = useSyncExternalStore(operations.subscribeModels, operations.getModelSnapshot, operations.getModelSnapshot)
  const region = regionOf(snapshot.value)
  const [changing, setChanging] = useState(false)
  const [accountBusy, setAccountBusy] = useState(false)
  const [notice, setNotice] = useState<QoderCredentialCopy>()
  const mutating = useRef(false)
  const canChange = snapshot.status === 'ready' && snapshot.writable && !changing && !accountBusy

  const changeRegion = async (next: QoderRegion) => {
    if (!canChange || next === region || mutating.current) return
    mutating.current = true
    setChanging(true)
    setNotice(undefined)
    try { const result = await operations.storeRegion(next); setNotice(result.ok ? 'regionChanged' : operationNotice(result.error, 'regionChangeFailed')) }
    catch { setNotice('regionChangeFailed') }
    finally { mutating.current = false; setChanging(false) }
  }

  return <section className={`${css.credential} ${css.credentialEditor}`} aria-label={t('accountConnectionTitle')}>
    <div className={css.connectionHead}>
      <strong className={css.credentialName}>{t('accountConnectionTitle')}</strong>
      <div className={css.regionGroup} role="radiogroup" aria-label={t('regionLabel')}>
        {(['global', 'china'] as const).map(value => <button key={value} type="button" role="radio"
          aria-checked={region === value} disabled={!canChange}
          className={`${css.regionOption} ${region === value ? css.regionOptionActive : ''}`}
          onClick={() => { void changeRegion(value) }}>{t(value === 'china' ? 'regionChina' : 'regionGlobal')}</button>)}
      </div>
    </div>
    {notice ? <p role="status" className={notice !== 'regionChanged' ? css.error : css.label}>{t(notice)}</p> : null}
    <QoderBrowserLogin key={region} region={region} operations={operations.authorization} credentials={operations} onBusyChange={setAccountBusy} t={t} />
    <p className={css.sharedNote}>{t('sharedAuthorization')}</p>
  </section>
}
