import test from 'node:test'
import assert from 'node:assert/strict'
import { reconcileQoderModels } from '../src/client/credential-operations.ts'

test('model settings retain smaller budgets and cap old larger budgets on rediscovery', () => {
  const current = [
    { id: 'small', name: 'Small', contextWindow: 100_000 },
    { id: 'large', name: 'Large', contextWindow: 1_000_000 },
  ]
  const discovered = current.map(model => ({ ...model, contextWindow: 200_000, maxContextWindow: 1_000_000 }))
  const result = reconcileQoderModels(current, discovered)
  assert.deepEqual(result.selected.map(model => model.contextWindow), [100_000, 200_000])
  assert.deepEqual(result.catalog, result.selected)
})

test('fetched models default to selected while removed models remain visible as unavailable', () => {
  const current = [
    { id: 'retained', name: 'Old retained name' },
    { id: 'removed', name: 'Removed model' },
  ]
  const discovered = [
    {
      id: 'retained',
      name: 'Current retained name',
      supportsEffort: true,
      reasoningEfforts: [{ id: 'high', name: 'high' }],
      defaultReasoningEffort: 'high',
      priceFactor: 1.6,
    },
    { id: 'new', name: 'New model' },
  ]

  const reconciled = reconcileQoderModels(current, discovered)

  assert.deepEqual(reconciled.catalog.map(model => model.id), ['retained', 'new', 'removed'])
  assert.deepEqual(reconciled.selected, discovered)
  assert.deepEqual([...reconciled.unavailableIds], ['removed'])
})

test('a remembered context tier survives rediscovery and widens the budget', () => {
  const contextOptions = {
    small: { tokenCount: 200_000, isDefault: true },
    large: { tokenCount: 1_000_000 },
  }
  const current = [{ id: 'tiered', name: 'Tiered', contextWindow: 1_000_000, contextTier: 'large', contextOptions }]
  const discovered = [{ id: 'tiered', name: 'Tiered', contextWindow: 200_000, maxContextWindow: 1_000_000, contextOptions }]

  const reconciled = reconcileQoderModels(current, discovered)

  assert.equal(reconciled.selected[0].contextTier, 'large')
  assert.equal(reconciled.selected[0].contextWindow, 1_000_000)
  assert.equal(reconciled.unavailableIds.size, 0)
})

test('a context tier the provider stops advertising falls back to the default budget', () => {
  const current = [{
    id: 'tiered', name: 'Tiered', contextWindow: 1_000_000, contextTier: 'large',
    contextOptions: { small: { tokenCount: 200_000, isDefault: true }, large: { tokenCount: 1_000_000 } },
  }]
  const discovered = [{ id: 'tiered', name: 'Tiered', contextWindow: 200_000, contextOptions: { small: { tokenCount: 200_000, isDefault: true } } }]

  const reconciled = reconcileQoderModels(current, discovered)

  assert.equal(reconciled.selected[0].contextTier, undefined)
  assert.equal(reconciled.selected[0].contextWindow, 200_000)
})
