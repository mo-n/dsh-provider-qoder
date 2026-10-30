import { useLayoutEffect, useRef, useState } from 'react'
import { Button, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { QoderWebSearchMode } from '../dsh/config.ts'
import type { QoderCredentialInjected, QoderModelSettingsSnapshot } from './credential-operations.ts'
import { operationNotice, type OperationResult } from './operation-result.ts'
import type { QoderCredentialCopy } from './locales.ts'
import css from './QoderCredentialCard.module.css'

export function QoderFeatureSettings({ operations, snapshot, t }: Pick<QoderCredentialInjected, 'operations' | 't'> & {
  snapshot: QoderModelSettingsSnapshot
}) {
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState<QoderCredentialCopy>()
  const pending = useRef(false)
  const mounted = useRef(true)
  useLayoutEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const writable = snapshot.status === 'ready' && snapshot.writable && !saving
  const mode = snapshot.value?.webSearchMode ?? 'auto'
  const save = async (write: () => Promise<OperationResult<void>>) => {
    if (!writable || pending.current) return
    pending.current = true
    setSaving(true)
    setFailed(undefined)
    try {
      const accepted = await write()
      if (mounted.current) setFailed(accepted.ok ? undefined : operationNotice(accepted.error, 'featureSaveFailed'))
    } catch {
      if (mounted.current) setFailed('featureSaveFailed')
    } finally {
      pending.current = false
      if (mounted.current) setSaving(false)
    }
  }
  const searchModes: Array<[QoderWebSearchMode, 'searchModeAuto' | 'searchModeAlways' | 'searchModeDisabled']> = [
    ['auto', 'searchModeAuto'], ['always', 'searchModeAlways'], ['disabled', 'searchModeDisabled'],
  ]
  return <section className={css.accountSection} data-qoder-features aria-label={t('featuresTitle')} aria-busy={saving}>
    <strong className={css.quotaLabel}>{t('featuresTitle')}</strong>
    <div className={css.featureSetting}>
      <span className={css.modelCatalogTitle}>{t('searchModeLabel')}</span>
      <div className={`${css.regionGroup} ${css.featureModes}`} role="radiogroup" aria-label={t('searchModeLabel')}>
        {searchModes.map(([value, label]) => <Button key={value} type="button" role="radio" size="sm"
          aria-checked={mode === value} disabled={!writable}
          variant={mode === value ? 'primary' : 'outline'}
          onClick={() => { if (mode !== value) void save(() => operations.storeWebSearchMode(value)) }}>{t(label)}</Button>)}
      </div>
      <span className={css.hint}>{t('searchModeHint')}</span>
    </div>
    <div className={`${css.featureSetting} ${css.featureToggleRow}`}>
      <span className={css.featureDescription}>
        <span className={css.modelCatalogTitle}>{t('imageSearchLabel')}</span>
        <span className={css.hint}>{t('imageSearchHint')}</span>
      </span>
      <Switch label={t('imageSearchLabel')} title={t('imageSearchHint')}
        checked={snapshot.value?.imageSearchEnabled ?? true} disabled={!writable}
        onChange={enabled => { void save(() => operations.storeImageSearchEnabled(enabled)) }} />
    </div>
    <div className={`${css.featureSetting} ${css.featureToggleRow}`}>
      <span className={css.featureDescription}>
        <span className={css.modelCatalogTitle}>{t('imageGenLabel')}</span>
        <span className={css.hint}>{t('imageGenHint')}</span>
      </span>
      <Switch label={t('imageGenLabel')} title={t('imageGenHint')}
        checked={snapshot.value?.imageGenEnabled ?? true} disabled={!writable}
        onChange={enabled => { void save(() => operations.storeImageGenEnabled(enabled)) }} />
    </div>
    {failed ? <p className={css.error} role="alert">{t(failed)}</p> : null}
  </section>
}
