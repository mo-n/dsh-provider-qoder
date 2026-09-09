/** Qoder model catalog domain types and built-in fallback entries. */

export interface QoderCatalogModel {
  id: string
  name: string
  description?: string
  contextWindow?: number
  maxTokens?: number
  source?: string
  isReasoning?: boolean
  supportsEffort?: boolean
  reasoningEfforts?: Array<{
    id: string
    name: string
    description?: string
  }>
  defaultReasoningEffort?: string
  priceFactor?: number
  contextOptions?: Record<string, { tokenCount?: number; isDefault?: boolean }>
}

export const defaultMaxTokens = 32_768

export const defaultModels: QoderCatalogModel[] = [
  {
    id: 'cmodel',
    name: 'Cantus (Qoder)',
    description: 'Default Global Qoder subscription model for quick validation',
    contextWindow: 1_000_000,
    maxTokens: defaultMaxTokens,
  },
  {
    id: 'auto',
    name: 'Qoder Auto',
    description: 'Server-routed Global Qoder model pool',
    contextWindow: 180_000,
    maxTokens: defaultMaxTokens,
  },
  {
    id: 'ultimate',
    name: 'Qoder Ultimate',
    description: 'Highest-capability Global Qoder model pool',
    contextWindow: 1_000_000,
    maxTokens: defaultMaxTokens,
  },
  {
    id: 'performance',
    name: 'Qoder Performance',
    description: 'Performance-oriented Global Qoder model pool',
    contextWindow: 1_000_000,
    maxTokens: defaultMaxTokens,
  },
  {
    id: 'efficient',
    name: 'Qoder Efficient',
    description: 'Efficiency-oriented Global Qoder model pool',
    contextWindow: 180_000,
    maxTokens: defaultMaxTokens,
  },
  {
    id: 'lite',
    name: 'Qoder Lite',
    description: 'Basic Global Qoder model pool',
    contextWindow: 180_000,
    maxTokens: defaultMaxTokens,
  },
]
