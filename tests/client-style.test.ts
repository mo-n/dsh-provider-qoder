import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const clientUrl = new URL('../src/client/', import.meta.url)

test('Qoder settings components satisfy DSH registration and design system constraints', async () => {
  const [credentialCard, modelCatalog, accountCard, entry, stylesheet, contextStylesheet] = await Promise.all([
    readFile(new URL('QoderCredentialCard.tsx', clientUrl), 'utf8'),
    readFile(new URL('QoderModelCatalog.tsx', clientUrl), 'utf8'),
    readFile(new URL('QoderAccountCard.tsx', clientUrl), 'utf8'),
    readFile(new URL('index.ts', clientUrl), 'utf8'),
    readFile(new URL('QoderCredentialCard.module.css', clientUrl), 'utf8'),
    readFile(new URL('QoderContextSelect.module.css', clientUrl), 'utf8'),
  ])

  // DSH extension slot registrations
  assert.match(entry, /name: 'settings\.section',[\s\S]*QoderAccountCard/u)
  assert.match(entry, /name: 'settings\.models\.footer',[\s\S]*QoderCredentialCard/u)
  assert.match(entry, /name: 'conversation\.input\.right',[\s\S]*QoderContextSelect/u)

  // DSH host context API contract (prevent accessing deprecated property directly)
  assert.match(entry, /ctx\.get\('modelDirectories'\)/u)
  assert.doesNotMatch(entry, /ctx\.modelDirectories\b/u)

  // Architectural boundary: model catalog & storage belongs to Account Card, not Credential Card
  assert.match(accountCard, /QoderModelCatalog/u)
  assert.match(accountCard, /operations\.storeModels/u)
  assert.match(accountCard, /operations\.storeWebSearchMode/u)
  assert.doesNotMatch(credentialCard, /QoderModelCatalog/u)
  assert.doesNotMatch(credentialCard, /operations\.storeModels/u)

  // Feature boundary: official model catalog uses checkbox toggles without free-form mutations
  assert.match(modelCatalog, /type="checkbox"/u)
  assert.doesNotMatch(modelCatalog, /type="(?:text|number)"/u)
  assert.doesNotMatch(modelCatalog, /modelsReset|modelAdd|modelRemove|modelsAdopt/u)

  // Design system and host isolation (no global style injection, no hardcoded hex, no deprecated tokens)
  assert.doesNotMatch(entry, /document\.createElement\('style'\)/u)
  assert.doesNotMatch(stylesheet, /--dsw-(?:surface|border|text-secondary|input-bg|accent|danger|success)\b/u)
  assert.doesNotMatch(stylesheet, /#[0-9a-f]{3,8}\b/iu)
  assert.doesNotMatch(contextStylesheet, /#[0-9a-f]{3,8}\b/iu)
})
