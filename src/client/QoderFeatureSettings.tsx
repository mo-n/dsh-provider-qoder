import { useLayoutEffect, useRef, useState } from 'react'
import { IconChevronDownOutlineRegular, Menu, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { QoderWebSearchMode } from '../dsh/config.ts'
import type { QoderCredentialInjected, QoderModelSettingsSnapshot } from './credential-operations.ts'
import { operationNotice, type OperationResult } from './operation-result.ts'
import type { QoderCredentialCopy } from './locales.ts'
import css from './QoderCredentialCard.module.css'

export function QoderFeatureSettings({ operations, snapshot, t }: Pick<QoderCredentialInjected, 'operations' | 't'> & {
  snapshot: QoderModelSettingsSnapshot
}) {
  const [saving, setSaving] = useState(false)
  const [searchMenuOpen, setSearchMenuOpen] = useState(false)
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
  return <section className={css.featureSection} data-qoder-features aria-label={t('featuresTitle')} aria-busy={saving}>
    <strong className={css.featureSectionTitle}>{t('featuresTitle')}</strong>
    <div className={`${css.featureSetting} ${css.featureToggleRow}`}>
      <span className={css.featureDescription}>
        <span className={css.featureTitle}>{t('searchModeLabel')}</span>
        <span className={css.featureHint}>{t('searchModeHint')}</span>
      </span>
      <div className={css.featureControl}>
        <Menu
          open={searchMenuOpen && writable}
          onClose={() => { setSearchMenuOpen(false) }}
          items={searchModes.map(([id, label]) => ({ id, label: t(label) }))}
          selectedId={mode}
          onSelect={id => {
            setSearchMenuOpen(false)
            const selected = searchModes.find(([value]) => value === id)?.[0]
            if (selected !== undefined && mode !== selected) void save(() => operations.storeWebSearchMode(selected))
          }}
          align="end"
          portal
          anchor={(
            <button type="button" className={css.searchModeSwitcher}
              aria-haspopup="menu" aria-expanded={searchMenuOpen && writable}
              aria-label={t('searchModeLabel')} disabled={!writable}
              onClick={() => { if (writable) setSearchMenuOpen(!searchMenuOpen) }}>
              <span className={css.searchModeSwitcherLabel}>{t(searchModes.find(([value]) => value === mode)![1])}</span>
              <IconChevronDownOutlineRegular className={css.searchModeChevron} size={14} aria-hidden="true" />
            </button>
          )}
        />
      </div>
    </div>
    <div className={`${css.featureSetting} ${css.featureToggleRow}`}>
      <span className={css.featureDescription}>
        <span className={css.featureTitle}>{t('imageSearchLabel')}</span>
        <span className={css.featureHint}>{t('imageSearchHint')}</span>
      </span>
      <Switch label={t('imageSearchLabel')} title={t('imageSearchHint')}
        checked={snapshot.value?.imageSearchEnabled ?? true} disabled={!writable}
        onChange={enabled => { void save(() => operations.storeImageSearchEnabled(enabled)) }} />
    </div>
    <div className={`${css.featureSetting} ${css.featureToggleRow}`}>
      <span className={css.featureDescription}>
        <span className={css.featureTitle}>{t('imageGenLabel')}</span>
        <span className={css.featureHint}>{t('imageGenHint')}</span>
      </span>
      <Switch label={t('imageGenLabel')} title={t('imageGenHint')}
        checked={snapshot.value?.imageGenEnabled ?? true} disabled={!writable}
        onChange={enabled => { void save(() => operations.storeImageGenEnabled(enabled)) }} />
    </div>
    {failed ? <p className={css.error} role="alert">{t(failed)}</p> : null}
  </section>
}
