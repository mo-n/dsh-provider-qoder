/** Qoder transport endpoints for Global and China service regions. */

export type QoderRegion = 'global' | 'china'

export interface QoderRegionEndpoints {
  baseUrl: string
  openApiUrl: string
}

export const qoderRegionEndpoints: Record<QoderRegion, QoderRegionEndpoints> = {
  global: {
    baseUrl: 'https://api3.qoder.sh/',
    openApiUrl: 'https://openapi.qoder.sh',
  },
  china: {
    baseUrl: 'https://gateway.qoder.com.cn/',
    openApiUrl: 'https://openapi.qoder.com.cn',
  },
}

export const qoderGlobalBaseUrl = qoderRegionEndpoints.global.baseUrl
export const qoderGlobalOpenApiUrl = qoderRegionEndpoints.global.openApiUrl

export function resolveQoderEndpoints(region: QoderRegion = 'global'): QoderRegionEndpoints {
  return qoderRegionEndpoints[region] ?? qoderRegionEndpoints.global
}

export function getQoderChatUrl(region: QoderRegion = 'global'): string {
  const { baseUrl } = resolveQoderEndpoints(region)
  return `${baseUrl}algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`
}

export function getQoderModelListUrl(region: QoderRegion = 'global'): string {
  const { baseUrl } = resolveQoderEndpoints(region)
  return `${baseUrl}algo/api/v2/model/list?Encode=1`
}

export function getQoderExchangeUrl(region: QoderRegion = 'global'): string {
  const { openApiUrl } = resolveQoderEndpoints(region)
  return `${openApiUrl}/api/v1/jobToken/exchange`
}

export function getQoderUserInfoUrl(region: QoderRegion = 'global'): string {
  const { openApiUrl } = resolveQoderEndpoints(region)
  return `${openApiUrl}/api/v1/userinfo`
}

export function getQoderUsageUrl(region: QoderRegion = 'global'): string {
  const { openApiUrl } = resolveQoderEndpoints(region)
  return `${openApiUrl}/api/v2/quota/usage`
}

