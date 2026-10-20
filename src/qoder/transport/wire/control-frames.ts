/** Non-model SSE data sent by Qoder's model transports. Never log its payload. */
export type QoderControlFrameKind = 'done' | 'quota-available' | 'quota-exceeded' | 'notifications'

export function qoderControlFrameKind(data: string): QoderControlFrameKind | undefined {
  if (data === '[DONE]') return 'done'
  if (data === '[NOT_EXCEED_QUOTA]') return 'quota-available'
  if (data.startsWith('[EXCEED_QUOTA]')) return 'quota-exceeded'
  if (data.startsWith('[NOTIFICATIONS]')) return 'notifications'
  return undefined
}
