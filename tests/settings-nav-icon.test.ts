import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

async function mountIcon() {
  const file = new URL('../src/client/settings-nav-icon.ts', import.meta.url)
  const source = ts.transpileModule(await readFile(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText
  const marker = 'data-provider-qoder-nav-icon'
  const row = (label: string, icon = true) => ({
    textContent: label,
    attributes: new Set<string>(),
    querySelector: () => icon ? {} : null,
    setAttribute(name: string) { this.attributes.add(name) },
    removeAttribute(name: string) { this.attributes.delete(name) },
  })
  const qoder = row('Qoder')
  const other = row('Models')
  const noIcon = row('Qoder', false)
  let rows = [qoder, other, noIcon]
  let label = 'Qoder'
  let styleRemoved = false
  let disconnected = false
  let changed!: () => void
  let cleanup!: () => void
  const queued: Array<() => void> = []
  const style = { dataset: {}, textContent: '', remove() { styleRemoved = true } }
  const exports: { installQoderSettingsNavIcon?: (ctx: unknown, resolve: () => string) => void } = {}
  runInNewContext(source, {
    exports,
    require: () => '<svg xmlns="http://www.w3.org/2000/svg" />',
    document: {
      head: { appendChild() {} }, body: {},
      createElement: () => style,
      querySelectorAll: () => rows,
    },
    MutationObserver: class {
      constructor(callback: () => void) { changed = callback }
      observe() {}
      disconnect() { disconnected = true }
    },
    queueMicrotask: (callback: () => void) => queued.push(callback),
  })
  exports.installQoderSettingsNavIcon!({ effect(create: () => () => void) { cleanup = create() } }, () => label)
  return {
    qoder, other, noIcon, marker, style, queued,
    changed: () => changed(),
    flush() { queued.splice(0).forEach(callback => callback()) },
    setLabel(value: string) { label = value },
    removeRows() { rows = [] },
    cleanup: () => cleanup(),
    disposed: () => styleRemoved && disconnected,
  }
}

test('navigation artwork follows the live label and removes marks from detached rows', async () => {
  const ui = await mountIcon()
  assert.ok(ui.qoder.attributes.has(ui.marker))
  assert.equal(ui.other.attributes.size, 0)
  assert.equal(ui.noIcon.attributes.size, 0)
  ui.setLabel('Models')
  ui.changed()
  ui.changed()
  assert.equal(ui.queued.length, 1)
  ui.flush()
  assert.equal(ui.qoder.attributes.size, 0)
  assert.ok(ui.other.attributes.has(ui.marker))
  ui.removeRows()
  ui.changed()
  ui.flush()
  assert.equal(ui.other.attributes.size, 0)
  ui.cleanup()
})

test('disposing navigation artwork removes styles and marks and ignores queued work', async () => {
  const ui = await mountIcon()
  assert.match(ui.style.textContent, /mask: url\("data:image\/svg\+xml,/)
  ui.changed()
  ui.cleanup()
  ui.flush()
  assert.ok(ui.disposed())
  assert.equal(ui.qoder.attributes.size, 0)
  ui.changed()
  assert.equal(ui.queued.length, 0)
})
