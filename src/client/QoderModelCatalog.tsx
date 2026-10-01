import { useLayoutEffect, useState, useSyncExternalStore } from 'react'
import {
  contextTiersOf,
  formatContextTokens,
  formatRateFactor,
  resolveContextTier,
  type QoderCatalogModel,
} from '../qoder/catalog.ts'
import {
  type QoderCredentialOperations,
  type QoderCredentialInjected,
} from './credential-operations.ts'
import type { QoderRegion } from '../qoder/region.ts'
import { QoderModelCatalogEditor } from './model-catalog-editor.ts'
import css from './QoderCredentialCard.module.css'

interface QoderModelCatalogProps extends Pick<QoderCredentialInjected, 't'> {
  region: QoderRegion
  operations: Pick<QoderCredentialOperations, 'discoverModels' | 'storeModels'>
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
  const [editor] = useState(() => new QoderModelCatalogEditor(region, models, operations))
  const snapshot = useSyncExternalStore(editor.subscribe, editor.getSnapshot, editor.getSnapshot)
  useLayoutEffect(() => {
    editor.activate()
    return () => editor.dispose()
  }, [editor])
  useLayoutEffect(() => {
    editor.replaceModels(models)
  }, [editor, models])
  const displayedModels = snapshot.catalog
  const unavailableIds = snapshot.unavailableIds
  const selectedIds = new Set(snapshot.models.map(model => model.id))
  const busy = snapshot.pending !== undefined
  const fetching = snapshot.pending === 'discovering'
  const failure = snapshot.failureMessage || (snapshot.failure ? t(snapshot.failure) : undefined)

  const renderRate = (model: QoderCatalogModel): string => {
    if (model.isFree || model.priceFactor === 0) return t('modelRateFree')
    if (model.priceFactor === undefined) return t('modelRateUnknown')
    const current = formatRateFactor(model.priceFactor)
    if (model.originalPriceFactor !== undefined && model.originalPriceFactor > model.priceFactor) {
      return t('modelRateDiscount', {
        value: current,
        original: formatRateFactor(model.originalPriceFactor),
      })
    }
    return t('modelRate', { value: current })
  }

  const tieredModels = displayedModels.filter(model => contextTiersOf(model).length > 1)

  return (
    <section className={css.modelCatalog} aria-label={t('modelsTitle')}>
      <div className={hideTitle ? css.modelCatalogHeadCompact : css.modelCatalogHead}>
        {!hideTitle ? (
          <div>
            <strong className={css.modelCatalogTitle}>{t('modelsTitle')}</strong>
            <p className={css.modelCatalogMeta}>{t('modelsEnabled', { count: snapshot.models.length })}</p>
          </div>
        ) : null}
        <button
          type="button"
          className={css.linkButton}
          disabled={disabled || busy || Boolean(fetchDisabled)}
          onClick={() => { if (!disabled && !fetchDisabled) void editor.discover() }}
        >
          {fetching ? t('modelsFetching') : t('modelsFetch')}
        </button>
      </div>
      {failure ? <p className={css.error} role="alert">{failure}</p> : null}
      <div className={css.modelList}>
        {displayedModels.map(model => {
          const unavailable = unavailableIds.has(model.id)
          const tiers = contextTiersOf(model)
          const fallbackTier = tiers.find(tier => tier.isDefault) ?? tiers[tiers.length - 1]
          const selectedTier = resolveContextTier(model)?.key ?? fallbackTier?.key
          return (
            <div className={`${css.modelChoice} ${unavailable ? css.modelUnavailable : ''}`} key={model.id}>
              <label className={css.modelChoiceHead}>
                <input
                  type="checkbox"
                  checked={!unavailable && selectedIds.has(model.id)}
                  disabled={disabled || busy || unavailable}
                  onChange={event => { if (!disabled) void editor.toggle(model.id, event.currentTarget.checked) }}
                />
                <span className={css.modelChoiceName}>{model.name}</span>
                <span className={css.modelRate}>
                  {renderRate(model)}
                </span>
                <code>{model.id}</code>
                {unavailable ? <span className={css.modelBadge}>{t('modelUnavailable')}</span> : null}
              </label>
              {tiers.length > 1
                ? (
                  <label className={css.modelTier}>
                    <span className={css.modelTierLabel}>{t('contextTierLabel')}</span>
                    <select
                      className={css.modelTierSelect}
                      value={selectedTier ?? ''}
                      disabled={disabled || busy || unavailable || !selectedIds.has(model.id)}
                      onChange={event => { if (!disabled) void editor.selectTier(model.id, event.currentTarget.value) }}
                    >
                      {tiers.map(tier => (
                        <option key={tier.key} value={tier.key}>
                          {tier.isDefault
                            ? `${formatContextTokens(tier.tokenCount)}${t('contextTierDefaultSuffix')}`
                            : formatContextTokens(tier.tokenCount)}
                        </option>
                      ))}
                    </select>
                  </label>
                )
                : null}
            </div>
          )
        })}
      </div>
      {tieredModels.length > 0 ? <p className={css.modelTierHint}>{t('contextTierHint')}</p> : null}
    </section>
  )
}
