import { success, type OperationResult } from '../../src/client/operation-result.ts'
export { success }
export const refused: OperationResult<never> = { ok: false, error: { cause: 'unknown', outcome: 'not-completed', stage: 'test-write', completedStages: [], diagnostic: { operation: 'test', stage: 'test-write', cause: 'unknown', outcome: 'not-completed', completedStages: [] } } }
export const accepted = (value: boolean): OperationResult<void> => value ? success(undefined) : refused
