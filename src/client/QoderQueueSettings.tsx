import { useState } from 'react'
import { Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { QoderModelSettingsSnapshot } from './credential-operations.ts'
import type { QoderCredentialCopy } from './locales.ts'
import { defaultModelQueueMaxWaitMs } from '../qoder/queue.ts'

export function QoderQueueSettings({ snapshot, save, t }: {
  snapshot: QoderModelSettingsSnapshot
  save?: (ms: number) => Promise<boolean>
  t: (key: QoderCredentialCopy) => string
}) {
  const [failed, setFailed] = useState(false)
  const [pending, setPending] = useState(false)
  const stored = snapshot.value?.modelQueueMaxWaitMs ?? defaultModelQueueMaxWaitMs
  return <div>
    <label>
      {t('queueSetting')}
      <Input key={stored} type="number" min={1 / 60000} max={2_147_483_647 / 60000} step="any"
        defaultValue={stored / 60000} disabled={!save || !snapshot.writable || snapshot.status !== 'ready' || pending}
        onBlur={async event => {
          const ms = Math.round(Number(event.currentTarget.value) * 60000)
          if (!Number.isSafeInteger(ms) || ms < 1 || ms > 2_147_483_647) { setFailed(true); return }
          if (!save || ms === stored) return
          setPending(true)
          try { setFailed(!await save(ms)) } catch { setFailed(true) }
          finally { setPending(false) }
        }} />
    </label>
    <p>{t('queueSettingHint')}</p>
    {failed && <p role="alert">{t('saveFailed')}</p>}
  </div>
}
