/** A confirmed invalid local caller parameter, distinct from upstream rejections. */
import { QoderLlmError } from '../qoder/errors.ts'

export class QoderRequestError extends QoderLlmError {
  constructor(message: string) { super(message, 'INVALID_REQUEST') }
}
