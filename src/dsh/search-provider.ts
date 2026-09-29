/**
 * DSH WebSearchProvider implementation with initiator-aware dynamic routing.
 *
 * Implements the `@deepseek-ai/dsh-web` capability seam, routing search queries
 * to Qoder Center when an agent runs with a Qoder model (`dsh-provider-qoder`),
 * or delegating to a fallback search provider when another model is active.
 *
 * @module dsh-provider-qoder/dsh/search-provider
 */

import { QODER_PROVIDER_ID } from './provider.ts'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
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
  const agentsService = ctx.get('agents')
    ?? (ctx as unknown as { agents?: { currentInitiator?: () => { options?: { provider?: string } } } }).agents
  const agent = agentsService?.currentInitiator?.()
  const defaultModelService = ctx.get('agentDefaultModel') as unknown as { get?: () => { provider?: string } }
  return agent?.options?.provider ?? defaultModelService?.get?.()?.provider
}

export function shouldUseQoderSearch(mode: QoderWebSearchMode, provider?: string): boolean {
  return mode === 'always' || (mode === 'auto' && provider === QODER_PROVIDER_ID)
}

export interface QoderSearchProviderOptions {
  ctx: Context
  resolveTransport: () => QoderTransport
  getWebSearchMode: () => QoderWebSearchMode
  fallbackProvider?: WebSearchProvider
}

export class QoderSearchProvider implements WebSearchProvider {
  readonly id = QODER_SEARCH_PROVIDER_ID

  private readonly ctx: Context
  private readonly resolveTransport: () => QoderTransport
  private readonly getWebSearchMode: () => QoderWebSearchMode
  private readonly fallbackProvider?: WebSearchProvider

  constructor(options: QoderSearchProviderOptions) {
    this.ctx = options.ctx
    this.resolveTransport = options.resolveTransport
    this.getWebSearchMode = options.getWebSearchMode
    this.fallbackProvider = options.fallbackProvider
  }

  available(): boolean {
    return this.getWebSearchMode() !== 'disabled'
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const mode = this.getWebSearchMode()
    if (mode === 'disabled') {
      throw new WebError('Qoder web search is disabled in settings.', 'WEB_PROVIDER_UNAVAILABLE')
    }

    const providerRoute = initiatingModelProvider(this.ctx)

    // If mode is 'always' or the active model is Qoder, execute via Qoder Center
    if (shouldUseQoderSearch(mode, providerRoute)) {
      const result = await this.resolveTransport().searchWeb(request, signal)
      // The transparent route calls this provider directly, bypassing WebRuntime's result cap.
      if (request.maxResults === undefined || result.sources.length <= request.maxResults) return result
      return { ...result, sources: result.sources.slice(0, request.maxResults), truncated: true }
    }

    // Otherwise (mode is 'auto' and active model is non-Qoder), delegate to fallback provider
    const fallback = this.resolveFallback()
    if (fallback && fallback.available()) {
      return fallback.search(request, signal)
    }

    throw new WebError(
      `Current model provider is "${providerRoute ?? 'unknown'}" rather than "${QODER_PROVIDER_ID}", `
      + 'and no fallback web search provider is available. Switch to a Qoder model or configure an ambient search provider.',
      'WEB_PROVIDER_UNAVAILABLE',
    )
  }

  private resolveFallback(): WebSearchProvider | undefined {
    if (this.fallbackProvider && this.fallbackProvider.available()) {
      return this.fallbackProvider
    }
    const webService = this.ctx.get('web') as unknown as { searchProviders?: Map<string, WebSearchProvider> }
    const providers = webService?.searchProviders
    if (providers && typeof providers.entries === 'function') {
      for (const [id, provider] of providers.entries()) {
        if (id !== QODER_SEARCH_PROVIDER_ID && provider.available()) {
          return provider
        }
      }
    }
    return undefined
  }
}
