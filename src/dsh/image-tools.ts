/** Native DSH image tools; Qoder transport owns every upstream operation. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-fs'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { QoderTransport } from '../qoder/transport/index.ts'
import type { QoderHostRun } from '../qoder/turn.ts'
import { saveImageArtifact } from './image-artifacts.ts'
import { imageFailureDetails } from '../qoder/images.ts'
import type { QoderLogger } from '../qoder/transport/logging.ts'

export interface QoderImageToolsOptions {
  logger?: QoderLogger
  resolveTransport(): QoderTransport
  getImageSearchEnabled(): boolean
  getImageGenEnabled(): boolean
  captureHostRun?(sessionId: string): QoderHostRun | undefined
}

/** Recovery metadata identifies the accepted generation; it must not be replayed. */
export class QoderImageArtifactDeliveryError extends Error {
  readonly code = 'IMAGE_DELIVERY_FAILED'
  readonly requestId: string
  declare readonly imageUrl: string
  constructor(requestId: string, imageUrl: string, cause: unknown) {
    super(`Qoder image was generated, but file delivery failed. Automatic recovery is unavailable. Do not call ImageGen again; report requestId=${requestId} to the user.`, { cause })
    this.name = 'QoderImageArtifactDeliveryError'
    this.requestId = requestId
    Object.defineProperty(this, 'imageUrl', { value: imageUrl, enumerable: false })
  }
}

function nonblank(value: string, name: string): string {
  if (!value.trim()) throw new Error(`${name} must be a non-empty string`)
  return value
}

/** Register only while enabled; execute checks also reject retained old schemas. */
export function bindQoderImageTools(ctx: Context, options: QoderImageToolsOptions): { refresh(): void } {
  const registrations = new Set<() => void>()
  const refreshers = new Set<() => void>()
  ctx.inject(['tools'], toolCtx => {
    let removeSearch: (() => void) | undefined
    const refresh = () => {
      if (!options.getImageSearchEnabled() || !options.resolveTransport().searchImages) {
        removeSearch?.(); removeSearch = undefined
      } else if (!removeSearch) {
        removeSearch = toolCtx.tools.register(defineTool({
          name: 'ImageSearch',
          description: 'Search Qoder for images. Returns image and source URLs; does not download images.',
          parameters: {
            query: { type: 'string', required: true, description: 'Image search query (first 100 Unicode characters are used).' },
            count: { type: 'integer', description: 'Number of results, from 1 to 10; defaults to 5.' },
          },
          output: {
            schema: { type: 'json' },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
          },
          async execute(args, exec) {
            const started = performance.now()
            if (!options.getImageSearchEnabled()) throw new Error('Qoder image search is disabled.')
            const query = Array.from(nonblank(args.query, 'query')).slice(0, 100).join('')
            const count = args.count ?? 5
            if (!Number.isInteger(count) || count < 1 || count > 10) throw new Error('count must be an integer from 1 to 10')
            const transport = options.resolveTransport()
            if (!transport.searchImages) throw new Error('Qoder image search is unavailable.')
            exec.signal.throwIfAborted()
            const result = await transport.searchImages({ query, count }, exec.signal)
            exec.signal.throwIfAborted()
            // Transport result optional fields must not introduce undefined into JSON.
            return JSON.parse(JSON.stringify({ query, durationSeconds: (performance.now() - started) / 1000, results: result.results, requestId: result.requestId }))
          },
        }))
      }
    }
    refreshers.add(refresh)
    refresh()
    const dispose = () => { refreshers.delete(refresh); removeSearch?.() }
    registrations.add(dispose)
    toolCtx.effect(() => () => { registrations.delete(dispose); dispose() })
  })
  ctx.inject(['tools', 'attachments', 'fs'], imageCtx => {
    let removeGeneration: (() => void) | undefined
    const fs = imageCtx.get('fs')
    const refresh = () => {
      const available = options.getImageGenEnabled() && options.resolveTransport().generateImage
        && typeof fs?.processPathFromHostPath === 'function'
        && typeof imageCtx.attachments.saveFile === 'function'
        && typeof imageCtx.attachments.fileHostPath === 'function'
      if (!available) { removeGeneration?.(); removeGeneration = undefined; return }
      if (removeGeneration) return
      removeGeneration = imageCtx.tools.register(defineTool({
        name: 'ImageGen',
        description: 'Generate an image with Qoder and save its original bytes as a durable file. Returns an absolute path; use read_image to view it when available. Does not require a vision chat model. Do not repeat generation after a delivery failure.',
        parameters: {
          name: { type: 'string', required: true, description: 'Display filename; directory components are removed.' },
          prompt: { type: 'string', required: true, description: 'Description of the image to generate.' },
          size: { type: 'string', description: 'Image dimensions; defaults to 1024x1024.' },
        },
        output: {
          schema: { type: 'object', additionalProperties: false, properties: {
            path: { type: 'string', required: true }, requestId: { type: 'string', required: true },
            attachment: { type: 'object', required: true, additionalProperties: false, properties: {
              attachmentId: { type: 'string', required: true }, name: { type: 'string', required: true }, bytes: { type: 'number', required: true },
            } },
          } },
          render: (_args, result) => [
            { type: 'text', text: JSON.stringify({ path: result.path, requestId: result.requestId }) },
            { type: 'file', attachment: { ...result.attachment, attachmentId: AttachmentId(result.attachment.attachmentId) } },
          ],
        },
        async execute(args, exec) {
          if (!options.getImageGenEnabled()) throw new Error('Qoder image generation is disabled.')
          nonblank(args.name, 'name')
          nonblank(args.prompt, 'prompt')
          if (args.size !== undefined && !/^\d{2,5}x\d{2,5}$/.test(args.size)) throw new Error('size must have the form WIDTHxHEIGHT')
          const transport = options.resolveTransport()
          if (!transport.generateImage || !fs) throw new Error('Qoder image generation is unavailable.')
          const sessionId = exec.agent?.session.id
          const hostRun = sessionId === undefined ? undefined : options.captureHostRun?.(sessionId)
          exec.signal.throwIfAborted()
          const image = await transport.generateImage({ prompt: args.prompt, size: args.size, sessionId, hostRun }, exec.signal)
          const started = Date.now()
          options.logger?.debug?.('[Qoder Image] Attachment save started', { requestId: image.requestId, stage: 'attachment-save', byteLength: image.bytes.length })
          try {
            const artifact = await saveImageArtifact(imageCtx.attachments, fs, args.name, image, exec.signal)
            options.logger?.debug?.('[Qoder Image] Attachment save completed', { requestId: image.requestId, stage: 'attachment-save', durationMs: Date.now() - started })
            return { path: artifact.path, requestId: image.requestId, attachment: { ...artifact.attachment } }
          } catch (error) {
            options.logger?.warn?.('[Qoder Image] Failed', { requestId: image.requestId, stage: 'attachment-save', durationMs: Date.now() - started, cancelled: exec.signal.aborted, ...imageFailureDetails(error) })
            throw new QoderImageArtifactDeliveryError(image.requestId, image.imageUrl, error)
          }
        },
      }))
    }
    refreshers.add(refresh)
    refresh()
    const dispose = () => { refreshers.delete(refresh); removeGeneration?.() }
    registrations.add(dispose)
    imageCtx.effect(() => () => { registrations.delete(dispose); dispose() })
  })
  ctx.effect(() => () => { for (const dispose of registrations) dispose(); registrations.clear() })
  return { refresh: () => { for (const refresh of refreshers) refresh() } }
}
