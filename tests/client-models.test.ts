import test from 'node:test'
import assert from 'node:assert/strict'
import { reconcileQoderModels } from '../src/client/credential-operations.ts'

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
