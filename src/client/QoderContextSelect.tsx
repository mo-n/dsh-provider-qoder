import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { contextTiersOf, formatContextTokens, type QoderCatalogModel } from '../qoder/catalog.ts'
import type { QoderRegion } from '../qoder/region.ts'
import { QODER_PROVIDER_ID } from '../dsh/provider.ts'
import type { QoderCredentialCopy } from './locales.ts'
import { modelsOf, regionOf, type QoderCredentialOperations } from './credential-operations.ts'
import { isQoderProvider } from './context-selection.ts'
import { SessionTierState } from './session-tier-state.ts'
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
  operations?: Pick<QoderCredentialOperations, 'getModelSnapshot' | 'subscribeModels' | 'setSessionTier' | 'readSessionTier' | 'subscribeSessionTiers'>
  t?: (key: QoderCredentialCopy, values?: Record<string, string | number>) => string
  activeLocale?: () => string
  useProjection?: <T = unknown>(key: string) => T | undefined
}

export function QoderContextSelect(props: QoderContextSelectProps) {
  const { directory, operations, sessionId, useProjection } = props
  const directoryState = useSyncExternalStore(
    fn => (directory ? directory.subscribe(fn) : () => () => {}),
    () => (directory ? directory.getSnapshot() : null),
  )

  const modelSnapshot = useSyncExternalStore(
    fn => (operations ? operations.subscribeModels(fn) : () => () => {}),
    () => (operations ? operations.getModelSnapshot() : null),
  )

  const modelProj = useProjection ? useProjection<{
    lastUsed: { provider?: string; model?: string } | null
    next: { provider?: string; model?: string } | null
  }>('modelSelection') : undefined
  const pressure = useProjection ? useProjection<{ contextWindow?: number }>('contextPressure') : undefined
  if (!operations || !directoryState) return null
  const projectedCurrent = modelProj?.next ?? modelProj?.lastUsed

  const current = directoryState?.current ?? (projectedCurrent?.model ? {
    provider: projectedCurrent.provider ?? QODER_PROVIDER_ID,
    model: projectedCurrent.model,
  } : null)

  if (!current) return null

  const region: QoderRegion = regionOf(modelSnapshot?.value)
  const models = modelsOf(modelSnapshot?.value, region)

  const currentModelId = current.model.includes('/') ? current.model.split('/')[1] : current.model
  const currentProviderId = current.provider ?? (current.model.includes('/') ? current.model.split('/')[0] : undefined)

  const activeModel = models.find(m => m.id === currentModelId || m.id === current.model)
  if (!isQoderProvider(currentProviderId) || !activeModel) return null

  const tiers = contextTiersOf(activeModel)
  if (tiers.length <= 1) return null

  if (!sessionId) return null
  return <SessionContextSelect key={JSON.stringify([region, sessionId, activeModel.id])}
    {...props} sessionId={sessionId} operations={operations} region={region} activeModel={activeModel}
    historicalWindow={pressure?.contextWindow} lastUsed={modelProj?.lastUsed} />
}

function SessionContextSelect({ operations, sessionId, region, activeModel, t, historicalWindow, lastUsed }: QoderContextSelectProps & {
  sessionId: string
  operations: NonNullable<QoderContextSelectProps['operations']>
  region: QoderRegion
  activeModel: QoderCatalogModel
  historicalWindow?: number
  lastUsed?: { provider?: string; model?: string } | null
}) {
  const [open, setOpen] = useState(false)
  const [focusedIndex, setFocusedIndex] = useState(0)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])
  const focusedIndexRef = useRef(0)
  const state = useMemo(() => new SessionTierState({ region, sessionId, modelId: activeModel.id }, operations), [region, sessionId, activeModel.id, operations])
  const snapshot = useSyncExternalStore(state.subscribe, state.getSnapshot)
  useLayoutEffect(() => { state.activate(); return () => state.dispose() }, [state])
  // Settings and request history can change the host's fallback without a manual selection event.
  const catalogSignature = JSON.stringify(activeModel)
  useEffect(() => { void state.revalidate() }, [state, catalogSignature, historicalWindow, lastUsed?.provider, lastUsed?.model])
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
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  const tiers = contextTiersOf(activeModel)
  const currentTier = snapshot.selection
  const selectedTierKey = currentTier?.tierKey
  const pending = snapshot.loading || snapshot.saving
  const focusMenuItem = (index: number) => {
    if (!tiers.length) return
    const next = (index + tiers.length) % tiers.length
    focusedIndexRef.current = next
    setFocusedIndex(next)
    itemRefs.current[next]?.focus()
  }
  useLayoutEffect(() => {
    if (!open || pending) return
    const selectedIndex = tiers.findIndex(tier => tier.key === selectedTierKey)
    focusMenuItem(selectedIndex >= 0 ? selectedIndex : 0)
  }, [open])
  const closeMenu = (restoreTrigger: boolean) => {
    setOpen(false)
    if (restoreTrigger) triggerRef.current?.focus()
  }
  const selectTier = (tierKey: string) => {
    if (pending) return
    setOpen(false)
    // Keep the trigger focusable while the host write is pending so removing
    // the menu cannot strand focus on the document body.
    triggerRef.current?.focus()
    if (tierKey !== selectedTierKey || snapshot.error) void state.select(tierKey)
  }
  const handleMenuKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!tiers.length || pending) return
    if (e.key === 'Tab') {
      // Let the browser move focus out of the menu. The root blur handler closes it
      // after the next focus target is known, without stealing that focus back.
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      closeMenu(true)
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      focusMenuItem(focusedIndexRef.current + 1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      focusMenuItem(focusedIndexRef.current - 1)
    } else if (e.key === 'Home') {
      e.preventDefault()
      focusMenuItem(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      focusMenuItem(tiers.length - 1)
    }
  }
  const handleRootBlur = (e: ReactFocusEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
      if (open) setOpen(false)
    }
  }

  const defaultSuffix = t ? t('contextTierDefaultSuffix').replace(/[（）()]/g, '') : '默认'
  const selectTitle = t ? t('contextSelectTitle') : '选择上下文大小'
  const menuHeader = t ? t('contextSelectMenuHeader') : '上下文容量'

  return (
    <div className={css.root} ref={rootRef} onBlurCapture={handleRootBlur}>
      <button
        type="button"
        className={`${css.trigger} ${open ? css.triggerActive : ''}`}
        ref={element => { triggerRef.current = element }}
        disabled={!currentTier}
        aria-disabled={pending || !currentTier}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={selectTitle}
        title={`${selectTitle}: ${currentTier ? formatContextTokens(currentTier.tokenCount) : '…'}`}
        onClick={() => { if (!pending && currentTier) setOpen(prev => !prev) }}
      >
        <span className={css.icon}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M2 4.5A2.5 2.5 0 0 1 4.5 2h7A2.5 2.5 0 0 1 14 4.5v7a2.5 2.5 0 0 1-2.5 2.5h-7A2.5 2.5 0 0 1 2 11.5v-7zm2.5-1A1.5 1.5 0 0 0 3 4.5v7A1.5 1.5 0 0 0 4.5 13h7a1.5 1.5 0 0 0 1.5-1.5v-7A1.5 1.5 0 0 0 11.5 3.5h-7zM5 6h6v1H5V6zm0 3h4v1H5V9z"/>
          </svg>
        </span>
        <span className={css.label}>{currentTier ? formatContextTokens(currentTier.tokenCount) : '…'}</span>
        <span className={`${css.chevron} ${open ? css.chevronOpen : ''}`}>
          <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 4.5L6 7.5L9 4.5" />
          </svg>
        </span>
      </button>

      {snapshot.error && <div className={css.error}>
        <span role="alert">{t ? t(snapshot.operationError?.outcome === 'unknown' ? 'operationOutcomeUnknown' : 'contextSelectFailed') : 'contextSelectFailed'}</span>
        <button type="button" disabled={pending} onClick={() => { void state.refresh() }}>{t ? t('refresh') : 'refresh'}</button>
      </div>}
      {open && (
        <div className={css.menu} role="menu" aria-label={selectTitle} onKeyDown={handleMenuKeyDown}>
          <div className={css.menuHeader}>{menuHeader}</div>
          {tiers.map((tier, index) => {
            const isSelected = tier.key === selectedTierKey
            return (
              <button
                key={tier.key}
                type="button"
                role="menuitemradio"
                ref={element => { itemRefs.current[index] = element }}
                disabled={pending}
                aria-checked={isSelected}
                tabIndex={index === focusedIndex ? 0 : -1}
                className={`${css.option} ${isSelected ? css.optionSelected : ''}`}
                onFocus={() => { focusedIndexRef.current = index; setFocusedIndex(index) }}
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
