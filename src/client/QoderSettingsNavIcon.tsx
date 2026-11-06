import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import qoderSvg from './assets/qoder.svg'

// The minimum supported DSH SDK predates this optional slot.
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'settings.section.icon': {
      kind: 'list'
      scope: 'root'
      inline: true
      owner: { size: number; active: boolean }
    }
  }
}

const mask = `url("data:image/svg+xml,${encodeURIComponent(qoderSvg)}") center / contain no-repeat`

export function QoderSettingsNavIcon({ size }: PropsRuntime<'settings.section.icon'>) {
  return <span aria-hidden="true" style={{
    display: 'inline-block',
    width: size,
    height: size,
    backgroundColor: 'currentColor',
    WebkitMask: mask,
    mask,
  }} />
}
