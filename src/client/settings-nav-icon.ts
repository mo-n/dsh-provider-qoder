/** Qoder settings navigation artwork and the current DSH DOM compatibility adapter. */
import qoderSvg from './assets/qoder.svg'

interface IconEffectOwner {
  effect(callback: () => () => void, label: string): unknown
}

const marker = 'data-provider-qoder-nav-icon'
const rowSelector = '[role="dialog"] nav button'
const iconUrl = `data:image/svg+xml,${encodeURIComponent(qoderSvg)}`

/**
 * Install the Qoder navigation icon for the lifetime of the client plugin.
 * DSH currently exposes no section icon option. Keep DOM selectors, styles and
 * cleanup here so a future native icon interface can replace this adapter.
 * The label resolver must match the settings.section registration's live label.
 */
export function installQoderSettingsNavIcon(ctx: IconEffectOwner, resolveLabel: () => string): void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.pluginCss = 'dsh-provider-qoder/settings-nav-icon'
    style.textContent = `
      [${marker}] > svg { display: none; }
      [${marker}]::before {
        content: '';
        flex: none;
        width: 16px;
        height: 16px;
        background-color: currentColor;
        -webkit-mask: url("${iconUrl}") center / contain no-repeat;
        mask: url("${iconUrl}") center / contain no-repeat;
      }
    `
    document.head.appendChild(style)

    const marked = new Set<Element>()
    let disposed = false
    let scheduled = false
    const sync = () => {
      scheduled = false
      if (disposed) return
      const label = resolveLabel().trim()
      const matches = new Set<Element>()
      if (label) {
        for (const row of document.querySelectorAll(rowSelector)) {
          if (row.textContent?.trim() === label && row.querySelector(':scope > svg')) matches.add(row)
        }
      }
      for (const row of marked) {
        if (!matches.has(row)) {
          row.removeAttribute(marker)
          marked.delete(row)
        }
      }
      for (const row of matches) {
        row.setAttribute(marker, '')
        marked.add(row)
      }
    }
    const observer = new MutationObserver(() => {
      if (scheduled || disposed) return
      scheduled = true
      queueMicrotask(sync)
    })
    // Attribute changes made by this adapter do not schedule another sync.
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })
    sync()
    return () => {
      disposed = true
      observer.disconnect()
      for (const row of marked) row.removeAttribute(marker)
      marked.clear()
      style.remove()
    }
  }, 'provider-qoder: settings navigation icon')
}
