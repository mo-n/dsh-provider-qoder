/** Public package entry for the Qoder subscription provider. */

export { Config, type QoderModelsByRegion } from './dsh/config.ts'
export { apply, inject, name } from './dsh/plugin.ts'
export type { QoderAccountInfo } from './qoder/account.ts'
export type { QoderCatalogModel } from './qoder/catalog.ts'
export type { QoderRegion } from './qoder/region.ts'
