import { useMemo, useState } from 'react'
import type { QoderCatalogModel } from '../qoder/catalog.ts'
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
  onChange(models: QoderCatalogModel[]): void
}

interface ContextTierOption {
  key: string
  tokenCount: number
  isDefault: boolean
}

export function validateModelCatalog(models: readonly QoderCatalogModel[]): QoderCredentialCopy | undefined {
  return models.length === 0 ? 'modelsRequired' : undefined
}

/**
 * Provider-advertised context tiers of one model, smallest first. A tier without
 * a usable capacity cannot be selected and is dropped.
 */
function contextTiersOf(model: QoderCatalogModel): ContextTierOption[] {
  const options = model.contextOptions
  if (options === undefined) return []
  return Object.entries(options).flatMap(([key, value]) => {
    const tokenCount = value.tokenCount
    return typeof tokenCount === 'number' && Number.isFinite(tokenCount) && tokenCount > 0
      ? [{ key, tokenCount, isDefault: value.isDefault === true }]
      : []
  }).sort((left, right) => left.tokenCount - right.tokenCount)
}

/** Compact capacity label, e.g. `200K` or `1M`. */
function formatContextTokens(tokenCount: number): string {
  if (tokenCount >= 1_000_000) {
    const millions = tokenCount / 1_000_000
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`
  }
  if (tokenCount >= 1_000) {
    const thousands = tokenCount / 1_000
    return `${Number.isInteger(thousands) ? thousands : thousands.toFixed(1)}K`
  }
  return String(tokenCount)
}

export function QoderModelCatalog(props: QoderModelCatalogProps) {
  const { operations, models, disabled, onChange, t } = props
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
    setCatalog(source.map(apply))
    onChange(models.map(apply))
  }

  const tieredModels = displayedModels.filter(model => contextTiersOf(model).length > 1)

  return (
    <section className={css.modelCatalog} aria-label={t('modelsTitle')}>
      <div className={css.modelCatalogHead}>
        <div>
          <strong className={css.modelCatalogTitle}>{t('modelsTitle')}</strong>
          <p className={css.modelCatalogMeta}>{t('modelsEnabled', { count: models.length })}</p>
        </div>
        <button
          type="button"
          className={css.linkButton}
          disabled={disabled || fetching}
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
          const selectedTier = model.contextTier ?? fallbackTier?.key
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
                  {model.priceFactor === undefined
                    ? t('modelRateUnknown')
                    : t('modelRate', { value: model.priceFactor })}
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
                      disabled={disabled || unavailable}
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
