import { useEffect, useState } from 'react'
import { DisclosureRow, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { QoderRpcCaller } from './rpc-client.ts'
import type { QoderCredentialCopy } from './locales.ts'
import { watchQueueStatus, type QueueViewState } from './queue-status.ts'
import type { QoderQueueSnapshot } from '../qoder/queue.ts'
import css from './QoderQueueStatus.module.css'

interface QueueInjected {
  sessionId: string
  rpc: QoderRpcCaller
  t: (key: QoderCredentialCopy, values?: Record<string, string | number>) => string
}

function QueueRow({ item, unavailable, t }: { item: QoderQueueSnapshot; unavailable: boolean; t: QueueInjected['t'] }) {
  const [open, setOpen] = useState(false)
  const elapsed = Math.min(item.maxWaitMs, item.waitElapsedMs + Math.max(0, Date.now() - item.updatedAt))
  return <DisclosureRow
    icon={<StateDot state={unavailable ? 'warning' : 'ongoing'} />}
    title={unavailable ? t('queueUnavailable') : t('queueWaiting', { model: item.model })}
    open={open} expandable onToggle={() => setOpen(value => !value)} running={!unavailable}
    keepContentWhenOpen
    collapsedContent={<span className={css.elapsed} role="status">{t('queueElapsed', { seconds: Math.floor(elapsed / 1000) })}</span>}
    className={css.row}
  >
    <div className={css.details}>
      {item.queueCount !== undefined && <span>{t('queueCount', { count: item.queueCount })}</span>}
      {item.waitTimeMs !== undefined && <span>{t('queueEstimate', { seconds: Math.ceil(item.waitTimeMs / 1000) })}</span>}
      <span>{t('queueBudget', { seconds: Math.ceil(item.maxWaitMs / 1000) })}</span>
      {item.serviceAvailable === false && <span>{t('queueServiceUnavailable')}</span>}
    </div>
  </DisclosureRow>
}

/** A provider contribution in DSH's input dock, using its shared process-row primitives. */
export function QoderQueueStatus({ sessionId, rpc, t }: PropsRuntime<'conversation.input.dock'> & QueueInjected) {
  const [view, setView] = useState<{ sessionId: string; state: QueueViewState }>()
  useEffect(() => watchQueueStatus(rpc, sessionId, document, state => setView({ sessionId, state })), [rpc, sessionId])
  const state = view?.sessionId === sessionId ? view.state : undefined
  if (!state?.items.length) return null
  return <div className={css.queues} aria-label={t('queueTitle')}>
    {state.items.map(item => <QueueRow key={item.callId} item={item} unavailable={state.unavailable} t={t} />)}
  </div>
}
