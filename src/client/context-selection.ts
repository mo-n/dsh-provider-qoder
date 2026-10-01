import { QODER_PROVIDER_ID } from '../dsh/provider.ts'

export function isQoderProvider(provider?: string): boolean {
  return [QODER_PROVIDER_ID, 'qoder-official', 'qoder', 'qoder-subscription'].includes(provider ?? '')
}
