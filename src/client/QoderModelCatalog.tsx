import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react'
import { IconChevronDownOutlineRegular, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  contextTiersOf,
  formatContextTokens,
  resolveContextTier,
  type QoderCatalogModel,
} from '../qoder/catalog.ts'
import {
  type QoderCredentialOperations,
  type QoderCredentialInjected,
} from './credential-operations.ts'
import type { QoderRegion } from '../qoder/region.ts'
import { renderQoderModelRate } from './QoderModelLabel.tsx'
import { QoderModelCatalogEditor } from './model-catalog-editor.ts'
import css from './QoderCredentialCard.module.css'

interface QoderModelCatalogProps extends Pick<QoderCredentialInjected, 't'> {
  region: QoderRegion
  operations: Pick<QoderCredentialOperations, 'getCatalogEditor' | 'refreshCatalog' | 'editCatalog' | 'subscribeCatalog'>
  models: QoderCatalogModel[]
  disabled: boolean
  fetchDisabled?: boolean
  hideTitle?: boolean
}

/** The key resets directory state whenever the active Qoder service region changes. */
export function QoderModelCatalog(props: QoderModelCatalogProps) {
  return <RegionModelCatalog key={props.region} {...props} />
}

function RegionModelCatalog({ operations, models, region, disabled, fetchDisabled, hideTitle, t }: QoderModelCatalogProps) {
  const [editor] = useState(() => operations.getCatalogEditor?.(region, models) ?? new QoderModelCatalogEditor(region, models, operations))
  const [openTierModelId, setOpenTierModelId] = useState<string>()
  const snapshot = useSyncExternalStore(editor.subscribe, editor.getSnapshot, editor.getSnapshot)
  useLayoutEffect(() => {
    editor.activate()
    return () => editor.dispose()
  }, [editor])
  useLayoutEffect(() => {
    editor.replaceModels(models)
  }, [editor, models])
  const fetching = snapshot.pending === 'discovering' || snapshot.status?.refreshing === true
  const locked = fetching || snapshot.refreshRequested || snapshot.pending === 'saving' || !snapshot.status
  const busy = locked || snapshot.pendingToggles.size > 0
  const failure = snapshot.failure ?? (snapshot.status?.failure === 'save' ? 'modelsUpdateNotSaved'
    : snapshot.status?.failure === 'fetch' ? 'modelsFetchFailed' : undefined)

  return (
    <section className={css.modelCatalog} aria-label={t('modelsTitle')} aria-busy={fetching}>
      <div className={hideTitle ? css.modelCatalogHeadCompact : css.modelCatalogHead}>
        {!hideTitle ? (
          <div>
            <strong className={css.modelCatalogTitle}>{t('modelsTitle')}</strong>
            <p className={css.modelCatalogMeta}>{t('modelsEnabled', { count: snapshot.models.filter(model => model.enabled !== false).length })}</p>
          </div>
        ) : null}
        <button
          type="button"
          className={css.linkButton}
          disabled={disabled || locked || Boolean(fetchDisabled)}
          onClick={() => { if (!disabled && !fetchDisabled) void editor.discover() }}
        >
          <span aria-live="polite">{fetching ? t('modelsUpdating') : t(snapshot.status ? 'modelsFetch' : 'modelsLoading')}</span>
        </button>
      </div>
      {snapshot.savingToggles || snapshot.pending === 'saving' ? (
        <ModelSaveStatus t={t} />
      ) : snapshot.pendingToggles.size > 0 && snapshot.status?.refreshing ? (
        <span className={css.modelCatalogMeta} role="status">{t('modelWaitingForCatalog')}</span>
      ) : null}
      {failure && !fetching ? <p className={css.error} role="alert">{t(failure)}</p> : null}
      <div className={css.modelList}>
        {snapshot.models.map(model => {
          const missing = model.missingFromCatalog === true
          const rate = renderQoderModelRate(model, t)
          const pendingToggle = snapshot.pendingToggles.get(model.id)
          const enabled = pendingToggle ?? (model.enabled !== false)
          const tiers = contextTiersOf(model)
          const fallbackTier = tiers.find(tier => tier.isDefault) ?? tiers[tiers.length - 1]
          const selectedTier = resolveContextTier(model)?.key ?? fallbackTier?.key
          const selectedTierOption = tiers.find(tier => tier.key === selectedTier)
          const tierDisabled = disabled || busy || !enabled
          const tierLabel = (tier: typeof tiers[number]) => tier.isDefault
            ? `${formatContextTokens(tier.tokenCount)}${t('contextTierDefaultSuffix')}`
            : formatContextTokens(tier.tokenCount)
          return (
            <div className={css.modelChoice} key={model.id}>
              <div className={css.modelChoiceHead}>
                <label className={css.modelChoiceLabel}>
                  <input
                    type="checkbox"
                    checked={enabled}
                    disabled={disabled || locked}
                    onChange={event => {
                      if (!disabled && !locked) void editor.edit({ action: 'toggle', id: model.id, enabled: event.currentTarget.checked })
                    }}
                  />
                  <span className={css.modelName}>
                    <span className={css.modelChoiceName}>{model.name}</span>
                    {rate === null ? null : <span className={css.modelRate}>{rate}</span>}
                    {missing ? <span className={css.modelMissing}>{t('modelMissingFromCatalog')}</span> : null}
                  </span>
                </label>
                <div className={css.modelActions}>
                  {missing && !enabled ? (
                    <button type="button" className={css.modelDelete} disabled={disabled || busy}
                      onClick={() => { void editor.edit({ action: 'delete', id: model.id }) }}>
                      {t('modelDelete')}
                    </button>
                  ) : null}
                </div>
              </div>
              <div className={css.modelDetails}>
                <div className={css.modelMetadata}>
                  <code>{model.id}</code>
                </div>
                {tiers.length > 1
                  ? (
                    <div className={css.modelTier}>
                      <Menu
                        open={openTierModelId === model.id && !tierDisabled}
                        onClose={() => { setOpenTierModelId(undefined) }}
                        items={tiers.map(tier => ({ id: tier.key, label: tierLabel(tier) }))}
                        selectedId={selectedTier}
                        onSelect={key => {
                          setOpenTierModelId(undefined)
                          if (!tierDisabled && key !== selectedTier && tiers.some(tier => tier.key === key)) {
                            void editor.edit({ action: 'selectTier', id: model.id, tierKey: key })
                          }
                        }}
                        align="start"
                        portal
                        anchor={(
                          <button type="button" className={css.modelTierSelect}
                            aria-label={`${model.name} ${t('contextTierLabel')}`}
                            aria-haspopup="menu" aria-expanded={openTierModelId === model.id && !tierDisabled}
                            disabled={tierDisabled}
                            onClick={() => { if (!tierDisabled) setOpenTierModelId(openTierModelId === model.id ? undefined : model.id) }}>
                            <span>{selectedTierOption ? tierLabel(selectedTierOption) : ''}</span>
                            <IconChevronDownOutlineRegular size={14} aria-hidden="true" />
                          </button>
                        )}
                      />
                    </div>
                  )
                  : null}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function ModelSaveStatus({ t }: Pick<QoderCredentialInjected, 't'>) {
  const [showSaving, setShowSaving] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setShowSaving(true), 500)
    return () => clearTimeout(timer)
  }, [])

  return showSaving ? <span className={css.modelCatalogMeta} role="status">{t('saving')}</span> : null
}
