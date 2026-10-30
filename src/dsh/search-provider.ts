/**
 * DSH WebSearchProvider implementation with initiator-aware dynamic routing.
 *
 * Implements the `@deepseek-ai/dsh-web` capability seam, routing search queries
 * to Qoder Center when an agent runs with a Qoder model (`dsh-provider-qoder`),
 * while the host owns selection when another model is active.
 *
 * @module dsh-provider-qoder/dsh/search-provider
 */

import { QODER_PROVIDER_ID } from './provider.ts'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import {
  WebError,
  type WebSearchProvider,
  type WebSearchRequest,
  type WebSearchResult,
} from '@deepseek-ai/dsh-web'
import type { QoderTransport } from '../qoder/transport/index.ts'
import type { QoderWebSearchMode } from './config.ts'

export const QODER_SEARCH_PROVIDER_ID = 'qoder'

export function initiatingModelProvider(ctx: Context): string | undefined {
  const agent = ctx.get('agents')?.currentInitiator()
  return agent?.options.provider ?? ctx.get('agentDefaultModel')?.currentSelection().provider
}

export function shouldUseQoderSearch(mode: QoderWebSearchMode, provider?: string): boolean {
  return mode === 'always' || (mode === 'auto' && provider === QODER_PROVIDER_ID)
}

export interface QoderSearchProviderOptions {
  ctx: Context
  resolveTransport: () => QoderTransport
  getWebSearchMode: () => QoderWebSearchMode
}

export class QoderSearchProvider implements WebSearchProvider {
  readonly id = QODER_SEARCH_PROVIDER_ID

  private readonly ctx: Context
  private readonly resolveTransport: () => QoderTransport
  private readonly getWebSearchMode: () => QoderWebSearchMode

  constructor(options: QoderSearchProviderOptions) {
    this.ctx = options.ctx
    this.resolveTransport = options.resolveTransport
    this.getWebSearchMode = options.getWebSearchMode
  }

  available(): boolean {
    return shouldUseQoderSearch(this.getWebSearchMode(), initiatingModelProvider(this.ctx))
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    if (!this.available()) {
      throw new WebError('Qoder web search is unavailable for the current model and search mode.', 'WEB_PROVIDER_UNAVAILABLE')
    }
    const result = await this.resolveTransport().searchWeb(request, signal)
    // The transparent route bypasses WebRuntime's result cap.
    if (request.maxResults === undefined || result.sources.length <= request.maxResults) return result
    return { ...result, sources: result.sources.slice(0, request.maxResults), truncated: true }
  }
}

/** Keep host selection authoritative whenever Qoder is not eligible. */
export function bindQoderSearch(ctx: Context, options: Omit<QoderSearchProviderOptions, 'ctx'>): void {
  ctx.inject(['web'], webCtx => {
    if (typeof webCtx.web.search !== 'function') throw new Error('Qoder web search requires the DSH WebRuntime.search API.')
    const provider = new QoderSearchProvider({ ...options, ctx })
    webCtx.web.registerSearchProvider(provider)
    const originalDescriptor = Object.getOwnPropertyDescriptor(webCtx.web, 'search')
    const originalSearch = webCtx.web.search
    webCtx.effect(() => {
      const routedSearch: typeof originalSearch = (request, signal) => provider.available()
        ? provider.search(request, signal)
        : originalSearch.call(webCtx.web, request, signal)
      webCtx.web.search = routedSearch
      return () => {
        // Cordis returns a fresh traced method on every read. Inspect the public
        // method descriptor to avoid replacing a subsequent owner's wrapper.
        if (Object.getOwnPropertyDescriptor(webCtx.web, 'search')?.value !== routedSearch) return
        if (originalDescriptor) Object.defineProperty(webCtx.web, 'search', originalDescriptor)
        else Reflect.deleteProperty(webCtx.web, 'search')
      }
    }, 'provider-qoder: transparent web search router')
  })
}
