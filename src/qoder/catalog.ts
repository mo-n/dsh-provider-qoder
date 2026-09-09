/** Browser-safe Qoder model catalog types and built-in fallback entries. */

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

interface QoderModelEntry {
  key?: unknown
  enable?: unknown
  display_name?: unknown
  max_input_tokens?: unknown
  max_output_tokens?: unknown
  context_config?: unknown
  is_reasoning?: unknown
  thinking_config?: unknown
  source?: unknown
  price_factor?: unknown
}

const discoveredMetadataKeys = [
  'description',
  'source',
  'isReasoning',
  'supportsEffort',
  'reasoningEfforts',
  'defaultReasoningEffort',
  'priceFactor',
  'contextOptions',
] as const satisfies readonly (keyof QoderCatalogModel)[]

const reasoningEffortOrder = new Map([
  ['low', 0],
  ['medium', 1],
  ['high', 2],
  ['xhigh', 3],
  ['max', 4],
])

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function contextOptionsOf(value: unknown): QoderCatalogModel['contextOptions'] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const options: NonNullable<QoderCatalogModel['contextOptions']> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
    const entry = raw as { token_count?: unknown; is_default?: unknown }
    const tokenCount = positiveNumber(entry.token_count)
    const isDefault = typeof entry.is_default === 'boolean' ? entry.is_default : undefined
    if (tokenCount === undefined && isDefault === undefined) continue
    options[key] = {
      ...tokenCount === undefined ? {} : { tokenCount },
      ...isDefault === undefined ? {} : { isDefault },
    }
  }
  if (Object.keys(options).length === 0) return undefined
  const largest = Math.max(...Object.values(options).map(option => option.tokenCount ?? 0))
  if (largest <= 0) return options
  return Object.fromEntries(Object.entries(options).map(([key, option]) => [key, {
    ...option,
    isDefault: option.tokenCount === largest,
  }]))
}

function reasoningEffortsOf(value: unknown): {
  efforts?: NonNullable<QoderCatalogModel['reasoningEfforts']>
  defaultEffort?: string
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const enabled = (value as { enabled?: unknown }).enabled
  if (typeof enabled !== 'object' || enabled === null || Array.isArray(enabled)) return {}
  const rawEfforts = (enabled as { efforts?: unknown }).efforts
  if (typeof rawEfforts !== 'object' || rawEfforts === null || Array.isArray(rawEfforts)) return {}
  const efforts: NonNullable<QoderCatalogModel['reasoningEfforts']> = []
  let defaultEffort: string | undefined
  for (const [id, raw] of Object.entries(rawEfforts)) {
    if (!id.trim() || typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
    const entry = raw as { description?: unknown; is_default?: unknown }
    efforts.push({
      id,
      name: id,
      ...typeof entry.description === 'string' && entry.description.trim()
        ? { description: entry.description.trim() }
        : {},
    })
    if (entry.is_default === true) defaultEffort = id
  }
  return {
    ...efforts.length === 0
      ? {}
      : {
          efforts: efforts.sort((left, right) =>
            (reasoningEffortOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER)
            - (reasoningEffortOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER)),
        },
    ...defaultEffort === undefined ? {} : { defaultEffort },
  }
}

export function normalizeQoderModels(payload: unknown): QoderCatalogModel[] {
  if (typeof payload !== 'object' || payload === null || !Array.isArray((payload as { chat?: unknown }).chat)) return []
  const models: QoderCatalogModel[] = []
  const seen = new Set<string>()
  for (const raw of (payload as { chat: QoderModelEntry[] }).chat) {
    if (typeof raw !== 'object' || raw === null || raw.enable !== true) continue
    const id = typeof raw.key === 'string' ? raw.key.trim() : ''
    if (!id || seen.has(id)) continue
    seen.add(id)
    const contextOptions = contextOptionsOf(raw.context_config)
    const contextWindow = Math.max(
      positiveNumber(raw.max_input_tokens) ?? 180_000,
      ...Object.values(contextOptions ?? {}).map(option => option.tokenCount ?? 0),
    )
    const thinking = typeof raw.thinking_config === 'object' && raw.thinking_config !== null
    const reasoning = reasoningEffortsOf(raw.thinking_config)
    models.push({
      id,
      name: typeof raw.display_name === 'string' && raw.display_name.trim() ? raw.display_name.trim() : id,
      contextWindow,
      maxTokens: positiveNumber(raw.max_output_tokens) ?? 32_768,
      source: typeof raw.source === 'string' && raw.source.trim() ? raw.source.trim() : 'system',
      isReasoning: raw.is_reasoning === true || thinking,
      supportsEffort: reasoning.efforts !== undefined,
      ...reasoning.efforts === undefined ? {} : { reasoningEfforts: reasoning.efforts },
      ...reasoning.defaultEffort === undefined ? {} : { defaultReasoningEffort: reasoning.defaultEffort },
      ...positiveNumber(raw.price_factor) === undefined ? {} : { priceFactor: positiveNumber(raw.price_factor) },
      ...contextOptions === undefined ? {} : { contextOptions },
    })
  }
  return models
}

export function mergeQoderDiscoveryMetadata(
  configured: readonly QoderCatalogModel[],
  discovered: readonly QoderCatalogModel[],
): QoderCatalogModel[] {
  const catalog = new Map(discovered.map(model => [model.id, model]))
  return configured.map((model) => {
    const advertised = catalog.get(model.id)
    if (advertised === undefined) return { ...model }

    const merged = { ...model }
    for (const key of discoveredMetadataKeys) delete merged[key]
    for (const key of discoveredMetadataKeys) {
      if (advertised[key] !== undefined) Object.assign(merged, { [key]: advertised[key] })
    }
    return merged
  })
}

export function hasSameQoderDiscoveryMetadata(
  left: readonly QoderCatalogModel[] | undefined,
  right: readonly QoderCatalogModel[],
): boolean {
  return left?.length === right.length && left.every((model, index) => {
    const candidate = right[index]
    return candidate?.id === model.id && discoveredMetadataKeys.every(key => (
      JSON.stringify(model[key]) === JSON.stringify(candidate[key])
    ))
  })
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
