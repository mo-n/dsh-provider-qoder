/** Split Qoder wire content into visible text and reasoning while removing tag artifacts. */

export interface QoderContentSegment {
  type: 'text' | 'reasoning'
  text: string
}

const thinkingTags = [
  { open: '<thinking>', close: '</thinking>' },
  { open: '<think>', close: '</think>' },
] as const

const allTags = thinkingTags.flatMap(tag => [tag.open, tag.close])

/** A fenced code block opens with at least this many markers on an otherwise blank line. */
const minFenceLength = 3

/** Upper bound on a held trailing marker run, so held output stays bounded. */
const maxHeldMarkerRunLength = 64

function trailingPrefixLength(text: string, candidates: readonly string[]): number {
  let best = 0
  for (const candidate of candidates) {
    const limit = Math.min(text.length, candidate.length - 1)
    for (let length = limit; length > best; length--) {
      if (text.endsWith(candidate.slice(0, length))) {
        best = length
        break
      }
    }
  }
  return best
}

/**
 * How many trailing markers a caller must hold back before deciding code state.
 *
 * A run of backticks opens or closes an inline code span by its length, so the run
 * can only be judged once it ends. Holding it costs a few characters of latency and
 * keeps the decision correct.
 */
function trailingMarkerRunLength(text: string): number {
  let length = 0
  while (length < text.length && length < maxHeldMarkerRunLength) {
    const char = text[text.length - 1 - length]
    if (char !== '`' && char !== '~') break
    length++
  }
  return length
}

function trimSeparator(text: string): string {
  if (text.startsWith('\n\n')) return text.slice(2)
  if (text.startsWith('\n')) return text.slice(1)
  return text
}

/**
 * Whether a position in the content stream sits inside Markdown code.
 *
 * Models embed real thinking blocks in `content`, but an answer may also *quote* a
 * tag — inline code, a fenced example. Qoder's content is markdown, so a quoted tag
 * is text. State is carried across chunks because a fence or a backtick run can be
 * split anywhere, and a long answer is delivered in many chunks.
 */
class MarkdownCodeState {
  private fenceMarker: '`' | '~' | undefined
  private fenceLength = 0
  private inlineTicks = 0
  private runMarker: '`' | '~' | undefined
  private runLength = 0
  private runStartedBlank = false
  private lineBlank = true

  get inCode(): boolean {
    return this.fenceMarker !== undefined || this.inlineTicks > 0
  }

  clone(): MarkdownCodeState {
    const copy = new MarkdownCodeState()
    copy.fenceMarker = this.fenceMarker
    copy.fenceLength = this.fenceLength
    copy.inlineTicks = this.inlineTicks
    copy.runMarker = this.runMarker
    copy.runLength = this.runLength
    copy.runStartedBlank = this.runStartedBlank
    copy.lineBlank = this.lineBlank
    return copy
  }

  consume(text: string): void {
    for (const char of text) this.consumeChar(char)
  }

  consumeChar(char: string): void {
    if (char === '\n') {
      this.closeRun()
      this.lineBlank = true
      return
    }
    if (char === '`' || char === '~') {
      if (this.runMarker === char) {
        this.runLength++
        return
      }
      this.closeRun()
      this.runMarker = char
      this.runLength = 1
      this.runStartedBlank = this.lineBlank
      return
    }
    this.closeRun()
    if (char !== ' ' && char !== '\t' && char !== '\r') this.lineBlank = false
  }

  /** Judge a finished marker run: fence delimiter, inline-code delimiter, or plain text. */
  private closeRun(): void {
    const marker = this.runMarker
    const length = this.runLength
    const startsBlankLine = this.runStartedBlank
    this.runMarker = undefined
    this.runLength = 0
    if (marker === undefined) return

    if (this.fenceMarker !== undefined) {
      // Only the fence's own marker, at least as long as its opener, closes it.
      if (marker === this.fenceMarker && length >= this.fenceLength) {
        this.fenceMarker = undefined
        this.fenceLength = 0
      }
      return
    }
    if (this.inlineTicks > 0) {
      // An inline span closes on a run of exactly its opening length.
      if (marker === '`' && length === this.inlineTicks) this.inlineTicks = 0
      return
    }
    if (startsBlankLine && length >= minFenceLength) {
      this.fenceMarker = marker
      this.fenceLength = length
      return
    }
    if (marker === '`') this.inlineTicks = length
  }
}

class NativeReasoningStripper {
  private buffer = ''

  push(chunk: string): string {
    this.buffer += chunk
    let output = ''
    while (this.buffer) {
      let firstPosition = -1
      let firstTag = ''
      for (const tag of allTags) {
        const position = this.buffer.indexOf(tag)
        if (position !== -1 && (firstPosition === -1 || position < firstPosition)) {
          firstPosition = position
          firstTag = tag
        }
      }
      if (firstPosition !== -1) {
        output += this.buffer.slice(0, firstPosition)
        this.buffer = this.buffer.slice(firstPosition + firstTag.length)
        continue
      }
      const held = trailingPrefixLength(this.buffer, allTags)
      output += this.buffer.slice(0, this.buffer.length - held)
      this.buffer = this.buffer.slice(this.buffer.length - held)
      break
    }
    return output
  }

  finish(): string {
    const output = allTags.some(tag => tag.startsWith(this.buffer)) ? '' : this.buffer
    this.buffer = ''
    return output
  }
}

export class QoderThinkingParser {
  private buffer = ''
  private mode: 'text' | 'reasoning' = 'text'
  private closingTag: string = thinkingTags[0].close
  /**
   * Reasoning text whose closing tag has not arrived yet.
   *
   * An opener is only a delimiter once its matching close tag proves it: a lone tag
   * the answer merely wrote must not turn the rest of the answer into thinking. Held
   * text is released as reasoning when the close arrives, and as visible text when
   * the stream ends without one.
   */
  private pendingReasoning = ''
  /**
   * The opener that entered the pending reasoning region.
   *
   * It is dropped when the matching close tag proves a real thinking block, and
   * restored verbatim when the stream ends without one, so the fallback reproduces
   * the model's text exactly.
   */
  private pendingOpener = ''
  private readonly code = new MarkdownCodeState()
  private readonly native = new NativeReasoningStripper()

  pushReasoning(chunk: string): QoderContentSegment[] {
    const text = this.native.push(chunk)
    return text ? [{ type: 'reasoning', text }] : []
  }

  pushContent(chunk: string): QoderContentSegment[] {
    const output: QoderContentSegment[] = []
    const pendingReasoning = this.native.finish()
    if (pendingReasoning) output.push({ type: 'reasoning', text: pendingReasoning })
    this.buffer += chunk

    while (this.buffer) {
      if (this.mode === 'reasoning') {
        const closeAt = this.buffer.indexOf(this.closingTag)
        if (closeAt !== -1) {
          this.pendingReasoning += this.buffer.slice(0, closeAt)
          if (this.pendingReasoning) output.push({ type: 'reasoning', text: this.pendingReasoning })
          this.pendingReasoning = ''
          this.pendingOpener = ''
          this.buffer = trimSeparator(this.buffer.slice(closeAt + this.closingTag.length))
          this.mode = 'text'
          continue
        }
        const held = trailingPrefixLength(this.buffer, [this.closingTag])
        const safeLength = this.buffer.length - held
        if (safeLength > 0) this.pendingReasoning += this.buffer.slice(0, safeLength)
        this.buffer = this.buffer.slice(safeLength)
        break
      }

      const found = this.findEligibleTag()
      if (found === undefined) {
        // Hold a partial tag and any trailing marker run, whose length is not yet known.
        const held = Math.max(
          trailingPrefixLength(this.buffer, allTags),
          trailingMarkerRunLength(this.buffer),
        )
        const safeLength = this.buffer.length - held
        if (safeLength > 0) {
          const text = this.buffer.slice(0, safeLength)
          this.code.consume(text)
          output.push({ type: 'text', text })
        }
        this.buffer = this.buffer.slice(safeLength)
        break
      }

      if (found.kind === 'close') {
        // A closing tag with no opener is the tail of a thinking block that arrived
        // through the native reasoning channel; the marker itself carries no content.
        if (found.position > 0) {
          const text = this.buffer.slice(0, found.position)
          this.code.consume(text)
          output.push({ type: 'text', text })
        }
        this.code.consume(this.buffer.slice(found.position, found.position + found.tag.close.length))
        this.buffer = trimSeparator(this.buffer.slice(found.position + found.tag.close.length))
        continue
      }

      if (found.position > 0) {
        const text = this.buffer.slice(0, found.position)
        this.code.consume(text)
        output.push({ type: 'text', text })
      }
      this.code.consume(found.tag.open)
      this.buffer = this.buffer.slice(found.position + found.tag.open.length)
      this.closingTag = found.tag.close
      this.pendingOpener = found.tag.open
      this.pendingReasoning = ''
      this.mode = 'reasoning'
    }
    return output
  }

  finish(): QoderContentSegment[] {
    const output: QoderContentSegment[] = []
    const pendingReasoning = this.native.finish()
    if (pendingReasoning) output.push({ type: 'reasoning', text: pendingReasoning })
    if (this.mode === 'reasoning') {
      // The opener never closed, so it was not a delimiter: restore it verbatim and
      // keep its text visible instead of leaving the answer inside the thinking channel.
      const recovered = this.pendingOpener + this.pendingReasoning
      if (recovered) output.push({ type: 'text', text: recovered })
      this.pendingOpener = ''
      this.pendingReasoning = ''
      this.mode = 'text'
    }
    if (this.buffer) {
      this.code.consume(this.buffer)
      output.push({ type: 'text', text: this.buffer })
      this.buffer = ''
    }
    return output
  }

  /**
   * Earliest tag that is a delimiter rather than quoted text.
   *
   * Scans character by character because eligibility depends on the code state at the
   * match, and code state advances with the text being scanned.
   */
  private findEligibleTag(): { position: number; tag: (typeof thinkingTags)[number]; kind: 'open' | 'close' } | undefined {
    const scan = this.code.clone()
    for (let index = 0; index < this.buffer.length; index++) {
      const char = this.buffer[index]!
      // Commit the run this character ends before judging the position it starts.
      scan.consumeChar(char)
      if (char !== '<' || scan.inCode) continue
      for (const tag of thinkingTags) {
        if (this.buffer.startsWith(tag.open, index)) return { position: index, tag, kind: 'open' }
        if (this.buffer.startsWith(tag.close, index)) return { position: index, tag, kind: 'close' }
      }
    }
    return undefined
  }
}
