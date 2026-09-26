import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { contextTiersOf, formatContextTokens, resolveContextTier } from '../qoder/catalog.ts'
import type { QoderRegion } from '../qoder/region.ts'
import { QODER_PROVIDER_ID } from '../dsh/provider.ts'
import type { QoderCredentialCopy } from './locales.ts'
import type { QoderCredentialOperations } from './credential-operations.ts'
import { historicalContextWindow, isQoderProvider, modelsOf, saveContextSelection } from './context-selection.ts'
import css from './QoderContextSelect.module.css'

export interface ModelDirectorySnapshot {
  current: { provider: string; model: string } | null
}

export interface ModelDirectoryStoreLike {
  getSnapshot(): ModelDirectorySnapshot | null
  subscribe(fn: () => void): () => void
}

export interface QoderContextSelectProps {
  sessionId?: string
  directory?: ModelDirectoryStoreLike
  operations?: Pick<QoderCredentialOperations, 'getModelSnapshot' | 'canRestoreContextHistory' | 'subscribeModels' | 'storeModels' | 'setSessionTier'>
  t?: (key: QoderCredentialCopy, values?: Record<string, string | number>) => string
  activeLocale?: () => string
  useProjection?: <T = unknown>(key: string) => T | undefined
}

export function QoderContextSelect(props: QoderContextSelectProps) {
  const { directory, operations, t, sessionId, useProjection } = props
  const [open, setOpen] = useState(false)
  const [manualTiers, setManualTiers] = useState<Record<string, string>>({})
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<{ key: string; message: 'contextSelectFailed' | 'contextDefaultFailed' } | null>(null)
  const saving = useRef(false)
  const legacyRegion = useRef<QoderRegion | undefined>(undefined)
  const rootRef = useRef<HTMLDivElement | null>(null)

  const directoryState = useSyncExternalStore(
    fn => (directory ? directory.subscribe(fn) : () => () => {}),
    () => (directory ? directory.getSnapshot() : null),
  )

  const modelSnapshot = useSyncExternalStore(
    fn => (operations ? operations.subscribeModels(fn) : () => () => {}),
    () => (operations ? operations.getModelSnapshot() : null),
  )

  useEffect(() => {
    if (!open) return
    const handleClickOutside = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  const modelProj = useProjection ? useProjection<{
    lastUsed: { provider?: string; model?: string } | null
    next: { provider?: string; model?: string } | null
  }>('modelSelection') : undefined
  const pressure = useProjection ? useProjection<{ contextWindow?: number }>('contextPressure') : undefined
  if (!operations) return null
  const projectedCurrent = modelProj?.next ?? modelProj?.lastUsed

  const current = directoryState?.current ?? (projectedCurrent?.model ? {
    provider: projectedCurrent.provider ?? QODER_PROVIDER_ID,
    model: projectedCurrent.model,
  } : null)

  if (!current) return null

  const region: QoderRegion = modelSnapshot?.value?.region === 'china' ? 'china' : 'global'
  if (legacyRegion.current === undefined && modelSnapshot?.value) legacyRegion.current = region
  const models = modelsOf(modelSnapshot?.value, region, legacyRegion.current ?? region)

  const currentModelId = current.model.includes('/') ? current.model.split('/')[1] : current.model
  const currentProviderId = current.provider ?? (current.model.includes('/') ? current.model.split('/')[0] : undefined)

  const activeModel = models.find(m => m.id === currentModelId || m.id === current.model)
  if (!isQoderProvider(currentProviderId) || !activeModel) return null

  const tiers = contextTiersOf(activeModel)
  if (tiers.length <= 1) return null

  const sessionKey = sessionId ? JSON.stringify([region, sessionId, activeModel.id]) : undefined
  const historicalWindow = operations.canRestoreContextHistory?.() === false ? undefined
    : historicalContextWindow(current, modelProj?.lastUsed, pressure?.contextWindow)
  const currentTier = resolveContextTier(activeModel, sessionKey ? manualTiers[sessionKey] : undefined, historicalWindow)
  if (!currentTier) return null
  const selectedTierKey = currentTier.key

  const selectTier = async (tierKey: string) => {
    setOpen(false)
    if (!sessionId || !sessionKey || saving.current) return
    if (tierKey === selectedTierKey && error?.key !== sessionKey) return
    saving.current = true
    setPending(true)
    setError(null)
    try {
      const result = await saveContextSelection(operations, sessionId, region, activeModel.id, tierKey, legacyRegion.current ?? region)
      if (result !== 'session-failed') setManualTiers(prev => ({ ...prev, [sessionKey]: tierKey }))
      if (result !== 'saved') setError({ key: sessionKey, message: result === 'session-failed' ? 'contextSelectFailed' : 'contextDefaultFailed' })
    } finally {
      saving.current = false
      setPending(false)
    }
  }

  const defaultSuffix = t ? t('contextTierDefaultSuffix').replace(/[（）()]/g, '') : '默认'
  const selectTitle = t ? t('contextSelectTitle') : '选择上下文大小'
  const menuHeader = t ? t('contextSelectMenuHeader') : '上下文容量'

  return (
    <div className={css.root} ref={rootRef}>
      <button
        type="button"
        className={`${css.trigger} ${open ? css.triggerActive : ''}`}
        disabled={pending || !sessionId}
        aria-expanded={open}
        aria-label={selectTitle}
        title={`${selectTitle}: ${formatContextTokens(currentTier.tokenCount)}`}
        onClick={() => setOpen(prev => !prev)}
      >
        <span className={css.icon}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M2 4.5A2.5 2.5 0 0 1 4.5 2h7A2.5 2.5 0 0 1 14 4.5v7a2.5 2.5 0 0 1-2.5 2.5h-7A2.5 2.5 0 0 1 2 11.5v-7zm2.5-1A1.5 1.5 0 0 0 3 4.5v7A1.5 1.5 0 0 0 4.5 13h7a1.5 1.5 0 0 0 1.5-1.5v-7A1.5 1.5 0 0 0 11.5 3.5h-7zM5 6h6v1H5V6zm0 3h4v1H5V9z"/>
          </svg>
        </span>
        <span className={css.label}>{formatContextTokens(currentTier.tokenCount)}</span>
        <span className={`${css.chevron} ${open ? css.chevronOpen : ''}`}>
          <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 4.5L6 7.5L9 4.5" />
          </svg>
        </span>
      </button>

      {error && error.key === sessionKey && <span role="alert" className={css.error}>{t ? t(error.message) : error.message}</span>}
      {open && (
        <div className={css.menu} role="menu" aria-label={selectTitle}>
          <div className={css.menuHeader}>{menuHeader}</div>
          {tiers.map(tier => {
            const isSelected = tier.key === selectedTierKey
            return (
              <button
                key={tier.key}
                type="button"
                role="menuitemradio"
                aria-checked={isSelected}
                className={`${css.option} ${isSelected ? css.optionSelected : ''}`}
                onClick={() => { void selectTier(tier.key) }}
              >
                <div className={css.optionInfo}>
                  <span>{formatContextTokens(tier.tokenCount)}</span>
                  {tier.isDefault && <span className={css.tag}>{defaultSuffix}</span>}
                </div>
                {isSelected && (
                  <span className={css.check}>
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3.5 8.5L6.5 11.5L12.5 4.5" />
                    </svg>
                  </span>
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

