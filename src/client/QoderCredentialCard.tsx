import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { isEnvironmentCredentialSource } from '../dsh/credential-contract.ts'
import type { QoderRegion } from '../qoder/region.ts'
import { regionOf, type QoderCredentialInjected, type QoderCredentialStatus } from './credential-operations.ts'
import css from './QoderCredentialCard.module.css'

export type QoderCredentialCardProps = QoderCredentialInjected

type ViewState =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'ready'; info: QoderCredentialStatus }

export function QoderCredentialCard({ operations, t }: QoderCredentialCardProps) {
  const [state, setState] = useState<ViewState>({ status: 'loading' })
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [regionDraft, setRegionDraft] = useState<QoderRegion>('global')
  const [regionDirty, setRegionDirty] = useState(false)
  const [mutation, setMutation] = useState<'saving' | 'removing' | undefined>()
  const [notice, setNotice] = useState<'saved' | 'saveFailed' | 'removeFailed' | undefined>()
  const modelSnapshot = useSyncExternalStore(
    operations.subscribeModels,
    operations.getModelSnapshot,
    operations.getModelSnapshot,
  )

  useEffect(() => {
    if (modelSnapshot.status === 'ready' && !regionDirty) {
      setRegionDraft(regionOf(modelSnapshot.value))
    }
  }, [modelSnapshot, regionDirty])

  const load = useCallback(async () => {
    const info = await operations.describe()
    setState(info === undefined ? { status: 'failed' } : { status: 'ready', info })
  }, [operations])

  useEffect(() => {
    void load()
    return operations.subscribe(() => { void load() })
  }, [load, operations])

  if (state.status === 'loading') {
    return <section className={css.credential}><p>{t('loading')}</p></section>
  }
  if (state.status === 'failed') {
    return (
      <section className={css.credential}>
        <p className={css.error} role="alert">{t('loadFailed')}</p>
        <button type="button" className={css.secondary} onClick={() => { void load() }}>
          {t('retry')}
        </button>
      </section>
    )
  }

  const configured = state.info.configured && !isEnvironmentCredentialSource(state.info.source)
  const writable = state.info.writable
  const busy = mutation !== undefined
  const normalized = draft.trim()
  const canModifyRegion = modelSnapshot.status === 'ready' && modelSnapshot.writable
  const currentRegion = regionOf(modelSnapshot.value)

  const closeEditor = (): void => {
    setDraft('')
    setRegionDraft(regionOf(modelSnapshot.value))
    setRegionDirty(false)
    setNotice(undefined)
    setEditing(false)
  }

  const save = async (): Promise<void> => {
    if (busy || (!regionDirty && normalized.length === 0)
      || (regionDirty && !canModifyRegion)) return
    setMutation('saving')
    setNotice(undefined)
    if (regionDirty) {
      const storedRegion = await operations.storeRegion(regionDraft)
      if (!storedRegion) {
        setNotice('saveFailed')
        setMutation(undefined)
        return
      }
      setRegionDirty(false)
    }
    const stored = normalized.length === 0 || await operations.store(normalized)
    if (stored) {
      setDraft('')
      setNotice('saved')
      if (normalized.length > 0) await load()
      setEditing(false)
    } else setNotice('saveFailed')
    setMutation(undefined)
  }

  const remove = async (): Promise<void> => {
    if (!configured || !writable || busy || !window.confirm(t('confirmRemove'))) return
    setMutation('removing')
    setNotice(undefined)
    const removed = await operations.remove()
    if (removed) {
      setDraft('')
      await load()
    } else setNotice('removeFailed')
    setMutation(undefined)
  }

  return (
    <section className={`${css.credential} ${css.credentialEditor}`} aria-label={t('title')}>
      <div className={css.credentialRowHead}>
        <span className={css.credentialIdentity}>
          <span className={css.credentialName}>{t('nav')}</span>
          <span className={css.regionBadge}>
            {currentRegion === 'china' ? t('regionChina') : t('regionGlobal')}
          </span>
          <span
            className={`${css.credentialDot} ${configured ? css.credentialDotConfigured : css.credentialDotMissing}`}
            role="img"
            aria-label={configured ? t('configured') : t('missing')}
            title={configured ? t('configured') : t('missing')}
          />
        </span>
        <button
          type="button"
          className={css.editButton}
          aria-expanded={editing}
          aria-controls="qoder-credential-editor"
          onClick={() => {
            if (editing) closeEditor()
            else {
              setNotice(undefined)
              setEditing(true)
            }
          }}
        >
          {t('edit')}
        </button>
      </div>
      {notice === undefined
        ? null
        : <p className={notice === 'saved' ? css.success : css.error} role="status">{t(notice)}</p>}
      {editing
        ? (
          <div id="qoder-credential-editor" className={css.editor}>
            <div className={css.regionSelector}>
              <span className={css.label}>{t('regionLabel')}</span>
              <div className={css.regionGroup} role="radiogroup" aria-label={t('regionLabel')}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={regionDraft === 'global'}
                  className={`${css.regionOption} ${regionDraft === 'global' ? css.regionOptionActive : ''}`}
                  disabled={!canModifyRegion || busy}
                  onClick={() => {
                    setRegionDraft('global')
                    setRegionDirty(true)
                  }}
                >
                  {t('regionGlobal')}
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={regionDraft === 'china'}
                  className={`${css.regionOption} ${regionDraft === 'china' ? css.regionOptionActive : ''}`}
                  disabled={!canModifyRegion || busy}
                  onClick={() => {
                    setRegionDraft('china')
                    setRegionDirty(true)
                  }}
                >
                  {t('regionChina')}
                </button>
              </div>
            </div>
            <label className={css.label} htmlFor="qoder-managed-credential">{t('tokenLabel')}</label>
            <input
              id="qoder-managed-credential"
              className={css.input}
              type="password"
              autoComplete="new-password"
              value={draft}
              disabled={!writable || busy}
              placeholder={configured ? t('configuredHint') : t('tokenPlaceholder')}
              onChange={event => setDraft(event.currentTarget.value)}
            />
            {!writable ? <p className={css.error} role="alert">{t('readOnly')}</p> : null}
            <div className={css.actions}>
              <button
                type="button"
                className={css.secondary}
                disabled={busy}
                onClick={closeEditor}
              >
                {t('cancel')}
              </button>
              {configured
                ? (
                  <button
                    type="button"
                    className={css.danger}
                    disabled={!writable || busy}
                    onClick={() => { void remove() }}
                  >
                    {mutation === 'removing' ? t('removing') : t('remove')}
                  </button>
                )
                : null}
              <button
                type="button"
                className={css.primary}
                disabled={busy || (!regionDirty && normalized.length === 0)
                  || (regionDirty && !canModifyRegion)
                  || (normalized.length > 0 && !writable)}
                onClick={() => { void save() }}
              >
                {mutation === 'saving' ? t('saving') : t('save')}
              </button>
            </div>
          </div>
        )
        : null}
    </section>
  )
}
