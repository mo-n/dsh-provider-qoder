import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const clientUrl = new URL('../src/client/', import.meta.url)

test('Qoder account and credential cards use the intended settings slots and scoped styles', async () => {
  const [credentialCard, modelCatalog, accountCard, entry, stylesheet, contextSelect, contextStylesheet] = await Promise.all([
    readFile(new URL('QoderCredentialCard.tsx', clientUrl), 'utf8'),
    readFile(new URL('QoderModelCatalog.tsx', clientUrl), 'utf8'),
    readFile(new URL('QoderAccountCard.tsx', clientUrl), 'utf8'),
    readFile(new URL('index.ts', clientUrl), 'utf8'),
    readFile(new URL('QoderCredentialCard.module.css', clientUrl), 'utf8'),
    readFile(new URL('QoderContextSelect.tsx', clientUrl), 'utf8'),
    readFile(new URL('QoderContextSelect.module.css', clientUrl), 'utf8'),
  ])

  assert.match(credentialCard, /import css from '\.\/QoderCredentialCard\.module\.css'/u)
  assert.match(accountCard, /import css from '\.\/QoderCredentialCard\.module\.css'/u)
  assert.match(credentialCard, /css\.credentialEditor/u)
  assert.match(accountCard, /className=\{css\.credential\}/u)
  assert.match(entry, /name: 'settings\.section',[\s\S]*QoderAccountCard/u)
  assert.match(entry, /name: 'settings\.models\.footer',[\s\S]*QoderCredentialCard/u)
  assert.match(entry, /name: 'conversation\.input\.right',[\s\S]*QoderContextSelect/u)
  assert.match(entry, /ctx\.get\('modelDirectories'\)/u)
  assert.doesNotMatch(entry, /ctx\.modelDirectories\b/u)
  assert.match(contextSelect, /modelsOf\(/u)
  assert.match(contextSelect, /useProjection[\s\S]*?'modelSelection'/u)
  assert.match(contextSelect, /import css from '\.\/QoderContextSelect\.module\.css'/u)
  assert.match(credentialCard, /aria-expanded=\{editing\}/u)
  assert.match(accountCard, /<summary[^>]*>[\s\S]*\{t\('modelsTitle'\)\}[\s\S]*modelSummaryBadge[\s\S]*<\/summary>/u)
  assert.doesNotMatch(credentialCard, /<summary/u)
  assert.match(accountCard, /renderAccount\(\)[\s\S]*renderModelCatalogSection\(\)[\s\S]*renderWebSearchSection\(\)/u)
  assert.match(accountCard, /QoderModelCatalog/u)
  assert.match(accountCard, /operations\.storeModels/u)
  assert.doesNotMatch(credentialCard, /QoderModelCatalog/u)
  assert.doesNotMatch(credentialCard, /operations\.storeModels/u)
  assert.match(modelCatalog, /operations\.discoverModels\(\)/u)
  assert.match(modelCatalog, /t\('modelsFetch'\)/u)
  assert.match(modelCatalog, /type="checkbox"/u)
  assert.match(modelCatalog, /t\('modelUnavailable'\)/u)
  assert.match(modelCatalog, /model\.priceFactor/u)
  assert.match(modelCatalog, /t\('modelRate'/u)
  assert.match(modelCatalog, /<select/u)
  assert.match(modelCatalog, /contextTier/u)
  assert.match(modelCatalog, /formatContextTokens/u)
  assert.match(modelCatalog, /t\('contextTierLabel'\)/u)
  assert.match(modelCatalog, /t\('contextTierHint'\)/u)
  assert.match(contextSelect, /formatContextTokens/u)
  assert.match(contextSelect, /contextSelectTitle/u)
  assert.doesNotMatch(modelCatalog, /type="(?:text|number)"/u)
  assert.doesNotMatch(modelCatalog, /modelsReset|modelAdd|modelRemove|modelsAdopt/u)
  assert.doesNotMatch(entry, /document\.createElement\('style'\)/u)
  assert.match(stylesheet, /var\(--dsw-alias-bg-layer-1\)/u)
  assert.match(stylesheet, /\.regionBadge/u)
  assert.match(stylesheet, /\.regionSelector/u)
  assert.match(accountCard, /operations\.storeWebSearchMode/u)
  assert.match(accountCard, /t\('searchModeLabel'\)/u)
  assert.match(accountCard, /css\.searchModeSection/u)
  assert.match(stylesheet, /\.searchModeSection/u)
  assert.match(stylesheet, /\.searchModeHintText/u)
  assert.match(accountCard, /usage\?\.dedicatedResourcePackages/u)
  assert.match(accountCard, /activeLocale\(\)/u)
  assert.match(accountCard, /css\.quotaDescription/u)
  assert.match(stylesheet, /\.quotaDescription/u)
  assert.match(stylesheet, /\.modelSummaryBadge/u)
  assert.match(stylesheet, /\.modelCatalogHeadCompact/u)
  assert.match(stylesheet, /\.customized[\s\S]*?border:\s*0\.5px solid var\(--dsw-alias-border-l2\)/u)
  assert.match(stylesheet, /\.accountSection[\s\S]*?border:\s*0\.5px solid var\(--dsw-alias-border-l2\)/u)
  assert.match(stylesheet, /\.searchModeSection[\s\S]*?border:\s*0\.5px solid var\(--dsw-alias-border-l2\)/u)
  assert.match(stylesheet, /\.customized[\s\S]*?border-radius:\s*var\(--dsw-radius-xl,\s*12px\)/u)
  assert.doesNotMatch(stylesheet, /--dsw-(?:surface|border|text-secondary|input-bg|accent|danger|success)\b/u)
  assert.doesNotMatch(stylesheet, /#[0-9a-f]{3,8}\b/iu)
  assert.doesNotMatch(contextStylesheet, /#[0-9a-f]{3,8}\b/iu)
})
