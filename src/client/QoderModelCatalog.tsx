import { useMemo, useState } from 'react'
import {
  contextTiersOf,
  formatContextTokens,
  formatRateFactor,
  resolveContextTier,
  type QoderCatalogModel,
} from '../qoder/catalog.ts'
import {
  reconcileQoderModels,
  type QoderCredentialOperations,
  type QoderCredentialInjected,
} from './credential-operations.ts'
import type { QoderCredentialCopy } from './locales.ts'
import css from './QoderCredentialCard.module.css'

interface QoderModelCatalogProps extends Pick<QoderCredentialInjected, 't'> {
  operations: Pick<QoderCredentialOperations, 'discoverModels'>
  models: QoderCatalogModel[]
  disabled: boolean
  fetchDisabled?: boolean
  hideTitle?: boolean
  onChange(models: QoderCatalogModel[]): void
}

export function validateModelCatalog(models: readonly QoderCatalogModel[]): QoderCredentialCopy | undefined {
  return models.length === 0 ? 'modelsRequired' : undefined
}

export function QoderModelCatalog(props: QoderModelCatalogProps) {
  const { operations, models, disabled, fetchDisabled, hideTitle, onChange, t } = props
  const [fetching, setFetching] = useState(false)
  const [failure, setFailure] = useState<string | undefined>()
  const [catalog, setCatalog] = useState<QoderCatalogModel[] | undefined>()
  const [unavailableIds, setUnavailableIds] = useState<Set<string>>(new Set())
  const displayedModels = catalog ?? models
  const selectedIds = useMemo(() => new Set(models.map(model => model.id)), [models])

  const fetchModels = async (): Promise<void> => {
    setFetching(true)
    setFailure(undefined)
    const result = await operations.discoverModels()
    setFetching(false)
    if (!result.ok) {
      setFailure(result.error.message || t('modelsFetchFailed'))
      return
    }
    const reconciled = reconcileQoderModels(catalog ?? models, result.value)
    setCatalog(reconciled.catalog)
    setUnavailableIds(reconciled.unavailableIds)
    onChange(reconciled.selected)
  }

  const toggleModel = (id: string, enabled: boolean): void => {
    if (unavailableIds.has(id)) return
    const source = catalog ?? models
    if (catalog === undefined) setCatalog(source)
    const nextSelected = new Set(selectedIds)
    if (enabled) nextSelected.add(id)
    else nextSelected.delete(id)
    onChange(source.filter(model => nextSelected.has(model.id) && !unavailableIds.has(model.id)))
  }

  // Selecting a tier moves both the DSH context budget and the tier a request asks
  // the provider for, so the entry keeps the chosen key alongside its capacity.
  const changeContextTier = (id: string, tierKey: string): void => {
    const source = catalog ?? models
    if (catalog === undefined) setCatalog(source)
    const apply = (model: QoderCatalogModel): QoderCatalogModel => {
      if (model.id !== id) return model
      const tokenCount = model.contextOptions?.[tierKey]?.tokenCount
      if (typeof tokenCount !== 'number' || !Number.isFinite(tokenCount) || tokenCount <= 0) return model
      return { ...model, contextTier: tierKey, contextWindow: tokenCount }
    }
    const nextCatalog = source.map(apply)
    setCatalog(nextCatalog)
    onChange(models.map(apply))
  }

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
            <p className={css.modelCatalogMeta}>{t('modelsEnabled', { count: models.length })}</p>
          </div>
        ) : null}
        <button
          type="button"
          className={css.linkButton}
          disabled={disabled || fetching || Boolean(fetchDisabled)}
          onClick={() => { void fetchModels() }}
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
                  disabled={disabled || unavailable}
                  onChange={event => { toggleModel(model.id, event.currentTarget.checked) }}
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
                      disabled={disabled || unavailable || !selectedIds.has(model.id)}
                      onChange={event => { changeContextTier(model.id, event.currentTarget.value) }}
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
