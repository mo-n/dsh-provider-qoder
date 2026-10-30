import { useLayoutEffect, useState, useSyncExternalStore } from 'react'
import { IconChevronDownOutlineRegular, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
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
  const [openTierModelId, setOpenTierModelId] = useState<string>()
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
    if (model.priceFactor === 0 || (model.priceFactor === undefined && model.isFree)) return t('modelRateFree')
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
          const selectedTierOption = tiers.find(tier => tier.key === selectedTier)
          const tierDisabled = disabled || busy || unavailable || !selectedIds.has(model.id)
          const tierLabel = (tier: typeof tiers[number]) => tier.isDefault
            ? `${formatContextTokens(tier.tokenCount)}${t('contextTierDefaultSuffix')}`
            : formatContextTokens(tier.tokenCount)
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
                  <div className={css.modelTier}>
                    <span className={css.modelTierLabel}>{t('contextTierLabel')}</span>
                    <Menu
                      open={openTierModelId === model.id && !tierDisabled}
                      onClose={() => { setOpenTierModelId(undefined) }}
                      items={tiers.map(tier => ({ id: tier.key, label: tierLabel(tier) }))}
                      selectedId={selectedTier}
                      onSelect={key => {
                        setOpenTierModelId(undefined)
                        if (!tierDisabled && key !== selectedTier && tiers.some(tier => tier.key === key)) {
                          void editor.selectTier(model.id, key)
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
          )
        })}
      </div>
    </section>
  )
}
