import { useEffect, useRef, useState } from 'react'
import { IconQueueOutlineRegular, IconWarningOutlineRegular, TextShimmer, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { QoderRpcCaller } from './rpc-client.ts'
import type { QoderCredentialCopy } from './locales.ts'
import { formatQueueDuration, watchQueueStatus, type QueueViewState } from './queue-status.ts'
import type { QoderQueueSnapshot } from '../qoder/queue.ts'
import css from './QoderQueueStatus.module.css'

interface QueueInjected {
  sessionId: string
  rpc: QoderRpcCaller
  t: (key: QoderCredentialCopy, values?: Record<string, string | number>) => string
}

function QueueRow({ item, unavailable, t }: { item: QoderQueueSnapshot; unavailable: boolean; t: QueueInjected['t'] }) {
  const elapsed = Math.min(item.maxWaitMs, item.waitElapsedMs + Math.max(0, Date.now() - item.updatedAt))
  const name = item.modelName ?? item.model
  const status = unavailable ? t('queueUnavailable') : t('queueWaiting', { model: name })
  const label = unavailable ? status : t('queueRunningFor', { model: name, duration: formatQueueDuration(elapsed, t) })
  return <div className={css.row} data-unavailable={unavailable || undefined}>
    <span className={css.visuallyHidden} role="status" aria-live="polite" aria-atomic="true">{status}</span>
    <details>
      <summary className={css.summary} aria-label={status}>
        <IconQueueOutlineRegular className={css.icon} aria-hidden="true" />
        <TextShimmer active={!unavailable} className={css.text} aria-hidden="true">{label}</TextShimmer>
        <span className={css.chevron} aria-hidden="true" />
      </summary>
      <div className={css.details}>
        {item.queueCount !== undefined && <span>{t('queueCount', { count: item.queueCount })}</span>}
        {item.waitTimeMs !== undefined && <span>{t('queueEstimate', { seconds: Math.ceil(item.waitTimeMs / 1000) })}</span>}
        <span>{t('queueBudget', { seconds: Math.ceil(item.maxWaitMs / 1000) })}</span>
        {item.serviceAvailable === false && <span>{t('queueServiceUnavailable')}</span>}
      </div>
    </details>
  </div>
}

/** A provider contribution in DSH's input dock, using its shared process-row primitives. */
export function QoderQueueStatus({ sessionId, rpc, t }: PropsRuntime<'conversation.input.dock'> & QueueInjected) {
  const [view, setView] = useState<{ sessionId: string; state: QueueViewState }>()
  const dismissed = useRef<{ sessionId: string; id: string } | undefined>(undefined)
  const [visible, setVisible] = useState(false)
  useEffect(() => watchQueueStatus(rpc, sessionId, document, state => setView({ sessionId, state }),
    () => dismissed.current?.sessionId === sessionId ? dismissed.current.id : undefined), [rpc, sessionId])
  useEffect(() => {
    const updateVisibility = () => setVisible(!document.hidden)
    updateVisibility()
    document.addEventListener('visibilitychange', updateVisibility)
    return () => document.removeEventListener('visibilitychange', updateVisibility)
  }, [])
  const state = view?.sessionId === sessionId ? view.state : undefined
  const refusalId = visible ? state?.refusalId : undefined
  return <>
    {refusalId && <Toast key={refusalId} text={t('modelRefusal')} icon={<IconWarningOutlineRegular />} onDone={() => {
      if (document.hidden) return
      dismissed.current = { sessionId, id: refusalId }
      setView(current => current?.sessionId === sessionId && current.state.refusalId === refusalId
        ? { sessionId, state: { ...current.state, refused: false, refusalId: undefined } }
        : current)
    }} />}
    {state && state.items.length > 0 && <div className={css.queues}>
      <div className={css.panel} aria-label={t('queueTitle')}>
        {state.items.map(item => <QueueRow key={item.callId} item={item} unavailable={state.unavailable} t={t} />)}
      </div>
    </div>}
  </>
}
