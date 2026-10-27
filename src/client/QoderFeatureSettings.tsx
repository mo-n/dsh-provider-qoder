import { useLayoutEffect, useRef, useState } from 'react'
import type { QoderWebSearchMode } from '../dsh/config.ts'
import type { QoderCredentialInjected, QoderModelSettingsSnapshot } from './credential-operations.ts'
import css from './QoderCredentialCard.module.css'

export function QoderFeatureSettings({ operations, snapshot, t }: Pick<QoderCredentialInjected, 'operations' | 't'> & {
  snapshot: QoderModelSettingsSnapshot
}) {
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const pending = useRef(false)
  const mounted = useRef(true)
  useLayoutEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const writable = snapshot.status === 'ready' && snapshot.writable && !saving
  const mode = snapshot.value?.webSearchMode ?? 'auto'
  const save = async (write: () => Promise<boolean>) => {
    if (!writable || pending.current) return
    pending.current = true
    setSaving(true)
    setFailed(false)
    try {
      const accepted = await write()
      if (mounted.current) setFailed(!accepted)
    } catch {
      if (mounted.current) setFailed(true)
    } finally {
      pending.current = false
      if (mounted.current) setSaving(false)
    }
  }
  const searchModes: Array<[QoderWebSearchMode, 'searchModeAuto' | 'searchModeAlways' | 'searchModeDisabled']> = [
    ['auto', 'searchModeAuto'], ['always', 'searchModeAlways'], ['disabled', 'searchModeDisabled'],
  ]
  return <section className={css.searchModeSection} aria-label={t('featuresTitle')} aria-busy={saving}>
    <strong className={css.quotaLabel}>{t('featuresTitle')}</strong>
    <div className={css.featureSetting}>
      <span className={css.label}>{t('searchModeLabel')}</span>
      <div className={`${css.regionGroup} ${css.featureModes}`} role="radiogroup" aria-label={t('searchModeLabel')}>
        {searchModes.map(([value, label]) => <button key={value} type="button" role="radio"
          aria-checked={mode === value} disabled={!writable}
          className={`${css.regionOption} ${mode === value ? css.regionOptionActive : ''}`}
          onClick={() => { if (mode !== value) void save(() => operations.storeWebSearchMode(value)) }}>{t(label)}</button>)}
      </div>
      <p className={css.searchModeHintText}>{t('searchModeHint')}</p>
    </div>
    <div className={css.featureSetting}>
      <label className={css.featureToggle}>
        <span>{t('imageSearchLabel')}</span>
        <input type="checkbox" role="switch" checked={snapshot.value?.imageSearchEnabled ?? true} disabled={!writable}
          onChange={event => { const enabled = event.currentTarget.checked; void save(() => operations.storeImageSearchEnabled(enabled)) }} />
      </label>
      <p className={css.searchModeHintText}>{t('imageSearchHint')}</p>
    </div>
    <div className={css.featureSetting}>
      <label className={css.featureToggle}>
        <span>{t('imageGenLabel')}</span>
        <input type="checkbox" role="switch" checked={snapshot.value?.imageGenEnabled ?? true} disabled={!writable}
          onChange={event => { const enabled = event.currentTarget.checked; void save(() => operations.storeImageGenEnabled(enabled)) }} />
      </label>
      <p className={css.searchModeHintText}>{t('imageGenHint')}</p>
    </div>
    {failed ? <p className={css.error} role="alert">{t('featureSaveFailed')}</p> : null}
  </section>
}
