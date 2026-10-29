/** Preserve generated image bytes in the host's verbatim attachment store. */
import { randomUUID } from 'node:crypto'
import { isAbsolute, win32 } from 'node:path'
import type { AttachmentStore, FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { QoderImageGenerationResult } from '../qoder/images.ts'

export interface ImageArtifactFileSystem {
  processPathFromHostPath(hostPath: string): string | undefined
}

export function imageArtifactName(name: string, mediaType: string): string {
  const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' }[mediaType]
  if (!extension) throw new Error(`Unsupported generated image media type: ${mediaType}`)
  const stem = name.normalize('NFKC').replace(/\.[^.]*$/, '').replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 80).replace(/^_+|_+$/g, '') || 'image'
  return `${stem}-${randomUUID()}.${extension}`
}

export async function saveImageArtifact(
  attachments: Pick<AttachmentStore, 'saveFile' | 'fileHostPath'>,
  fs: ImageArtifactFileSystem,
  name: string,
  image: QoderImageGenerationResult,
  signal: AbortSignal,
): Promise<{ path: string; attachment: FileAttachmentRef }> {
  signal.throwIfAborted()
  const attachment = await attachments.saveFile({ data: image.bytes, name: imageArtifactName(name, image.mediaType) })
  // Finish delivery after persistence even when cancellation arrives during the
  // non-cancellable saveFile operation; the host still owns result cancellation.
  const hostPath = attachments.fileHostPath(attachment)
  const path = hostPath === undefined ? undefined : fs.processPathFromHostPath(hostPath)
  if (!path || (!isAbsolute(path) && !win32.isAbsolute(path))) {
    throw new Error(`Generated image was saved as attachment ${attachment.attachmentId} (${attachment.name}), but the host cannot expose a readable absolute path. Do not generate again.`)
  }
  return { path, attachment }
}
