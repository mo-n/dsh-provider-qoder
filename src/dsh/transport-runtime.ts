/** Own the active region-bound transport and the configuration that created it. */
import type { Config } from './config.ts'
import { defaultModelQueueMaxWaitMs } from '../qoder/queue.ts'
import { defaultResponseHeaderTimeoutMs, defaultStreamIdleTimeoutMs, type QoderTransport } from '../qoder/transport/index.ts'

export function transportConfig(value: Config) {
  return {
    region: value.region ?? 'global',
    streamIdleTimeoutMs: value.streamIdleTimeoutMs ?? defaultStreamIdleTimeoutMs,
    responseHeaderTimeoutMs: value.responseHeaderTimeoutMs ?? defaultResponseHeaderTimeoutMs,
    modelQueueMaxWaitMs: value.modelQueueMaxWaitMs ?? defaultModelQueueMaxWaitMs,
    preserveThinking: value.preserveThinking ?? true,
    requestCompression: value.requestCompression ?? false,
    modelTransport: value.modelTransport ?? 'legacy',
  }
}
export type QoderRuntimeConfig = ReturnType<typeof transportConfig>

export class QoderTransportRuntime {
  private snapshot: { config: QoderRuntimeConfig; transport: QoderTransport }
  constructor(value: Config, factory: (config: QoderRuntimeConfig) => QoderTransport) {
    this.create = factory
    const config = Object.freeze(transportConfig(value))
    this.snapshot = { config, transport: this.create(config) }
  }
  private readonly create: (config: QoderRuntimeConfig) => QoderTransport
  get config(): Readonly<QoderRuntimeConfig> { return this.snapshot.config }
  get transport(): QoderTransport { return this.snapshot.transport }
  update(value: Config, force = false): boolean {
    const config = Object.freeze(transportConfig(value))
    if (!force && (Object.keys(config) as Array<keyof QoderRuntimeConfig>).every(key => config[key] === this.config[key])) return false
    const transport = this.create(config)
    this.snapshot = { config, transport }
    return true
  }
}
