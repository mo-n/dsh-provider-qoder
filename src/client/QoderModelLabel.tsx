import { useSyncExternalStore } from 'react'
import { Tag, type TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import { QODER_PROVIDER_ID } from '../dsh/provider.ts'
import { formatRateFactor } from '../qoder/catalog.ts'
import type { QoderCredentialInjected } from './credential-operations.ts'
import type { createModelRates } from './model-rates.ts'
import css from './QoderModelLabel.module.css'

type ModelBadge = {
  text: string | { readonly en: string; readonly [locale: string]: string }
  tone: Extract<TagTone, 'neutral' | 'info' | 'success' | 'warning'>
}

export interface ModelLabelOwner {
  provider: { id: string; name: string }
  model: { id: string; name: string; badge?: ModelBadge }
  placement: 'trigger' | 'menu' | 'option'
  selected: boolean
}

interface ModelLabelProps extends ModelLabelOwner, Pick<QoderCredentialInjected, 't'> {
  rates: ReturnType<typeof createModelRates>
  resolveBadgeText(text: ModelBadge['text']): string
}

export function QoderModelLabel({ provider, model, placement, rates, t, resolveBadgeText }: ModelLabelProps) {
  if (provider.id === QODER_PROVIDER_ID) {
    return placement === 'option' ? <QoderModelOption model={model} rates={rates} t={t} /> : model.name
  }
  if (!model.badge) return model.name
  const badge = <Tag className={css.badge} tone={model.badge.tone}>{resolveBadgeText(model.badge.text)}</Tag>
  return <span className={css.label}>
    {placement === 'trigger' ? badge : null}
    <span className={css.name}>{model.name}</span>
    {placement === 'trigger' ? null : badge}
  </span>
}

function QoderModelOption({ model, rates, t }: Pick<ModelLabelProps, 'model' | 'rates' | 't'>) {
  const rate = useSyncExternalStore(rates.subscribe, rates.getSnapshot).get(model.id)
  const price = rate?.priceFactor ?? (rate?.isFree ? 0 : undefined)
  if (price === undefined) return model.name
  if (price === 0) return <>{model.name} · {t('modelRateFree')}</>

  const current = `${formatRateFactor(price)}×`
  const original = rate?.originalPriceFactor
  if (original === undefined || original <= price) {
    return <>{model.name} · {current}</>
  }

  const originalRate = `${formatRateFactor(original)}×`
  return <span className={css.label}>
    <span className={css.name}>{model.name}</span>
    <span aria-hidden="true" className={css.label}>
      <span>· <del>{originalRate}</del></span>
      <Tag className={css.badge} tone="success">{current}</Tag>
    </span>
    <span className={css.visuallyHidden}>{t('modelRatePromotionLabel', { original: originalRate, current })}</span>
  </span>
}
