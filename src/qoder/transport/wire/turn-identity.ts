/**
 * Per-turn Qoder request identity.
 *
 * A DSH turn issues one model request per reasoning step, so a single
 * subscriber prompt becomes dozens of consecutive Qoder requests. Qoder's
 * Credits panel aggregates consumption per agent run — the `business.id` a
 * request reports — so every step of one turn must carry the same run identity
 * while the next subscriber prompt opens a new one.
 *
 * The adapter never sees a turn number, and the host appends messages to a
 * turn's history while it runs — its own context, notifications, delegated
 * agents' messages — so the boundary is derived from the history here. A turn is
 * the multiset of user-role messages it has accounted for: a subscriber message
 * the run has not seen opens the next turn, while host-appended context,
 * transport-synthesized markers, and anything an auxiliary call carries continue
 * the open record.
 *
 * Known limit: text identifies a message because the host's message ids are not
 * part of the wire shape. A subscriber who sends the same words twice with the
 * first copy already gone from history — compaction replaced that span — shares
 * the open record instead of opening a new one. Carrying the host's message
 * identity through translation is the fix, and needs the host to expose it on
 * the request the adapter receives.
 *
 * @module dsh-provider-qoder/qoder/transport/wire/turn-identity
 */

import crypto from 'node:crypto'
import type { QoderWireMessage } from './wire-types.ts'

/**
 * Which request field carries the turn identity.
 *
 * The official client renews `request_set_id` once per agent run
 * (`AgentLifecycle.requestSetId`) while `chat_record_id` equals that request's
 * own `request_id`. Qoder's consumption panel is the only authority on which
 * field it groups by, so the transport can be switched between the candidates
 * for a live comparison before one is pinned as the default.
 */
export type QoderTurnIdentityMode = 'request-set' | 'both' | 'chat-record'

/**
 * What a request is for.
 *
 * A conversation request continues, or opens, a subscriber turn. The host also
 * routes its own auxiliary calls — session title, compaction summary — through
 * the same provider with the same session identity but a message list of their
 * own, and those must never move a turn's boundary.
 */
export type QoderCallKind = 'conversation' | 'auxiliary'

/** Bounded per-session memory: one entry per conversation this process serves. */
export interface QoderTurnTrackerOptions {
  /**
   * Maximum remembered sessions, evicted coldest first.
   *
   * A conversation untouched for longer than `idleSessionTtlMs` is dropped
   * before any active one, because it cannot still be running a turn. Once every
   * recorded conversation is more recent than that, the ceiling decides, and
   * dropping one can split the turn it was running — so the ceiling is
   * deliberately far above the number of conversations a subscriber works on at
   * once.
   */
  maxSessions?: number
  /** How long a session may stay untouched before it becomes evictable. */
  idleSessionTtlMs?: number
  /**
   * Clock the tracker reads.
   *
   * Injectable so a caller can advance time in a test instead of waiting for a
   * real idle window.
   */
  now?: () => number
  /** Request field the turn identity is written to. Defaults to `request-set`. */
  mode?: QoderTurnIdentityMode
}

interface SessionTurnState {
  /**
   * How many times each user-role message has been accounted for by this turn.
   *
   * A turn is a multiset, not a position: later steps append context, history
   * may be trimmed, and the translation layer adds image markers, so a message
   * already seen belongs to the open record while a genuinely new occurrence of
   * one opens the next.
   */
  readonly claimed: Map<string, number>
  /** Stable record id of that turn. */
  currentTurnId: string
  /**
   * Agent-run identity reported to Qoder as `business.id`.
   *
   * The official client creates one per agent run, so keeping it stable for
   * every request of a turn is what makes the service aggregate the turn's
   * requests into one consumption record.
   */
  currentBusinessId: string
  /** When that agent run opened, reported as `business.begin_at`. */
  turnOpenedAt: number
  /** When this session last served a request, used only for eviction order. */
  lastTouchedAt: number
  /**
   * Turns opened in this session.
   *
   * The anchor alone cannot separate two consecutive turns carrying identical
   * input — a subscriber who repeats the same prompt would otherwise reuse the
   * previous record — so the ordinal keeps every new turn distinct.
   */
  turnCount: number
}

const defaultMaxSessions = 64
/** A conversation untouched for this long cannot still be mid-turn. */
const defaultIdleSessionTtlMs = 60 * 60 * 1000


/**
 * Where one user-role wire message came from.
 *
 * `prompt` is input a subscriber sent. `injected` is context the host appends
 * while a turn runs. `synthetic` is a marker this transport materializes while
 * translating a turn's own tool results. Only `prompt` may open a turn.
 */
export type QoderMessageOrigin = 'prompt' | 'injected' | 'synthetic'

/**
 * Openings of everything the host appends while a turn runs.
 *
 * One subscriber prompt is what the subscriber perceives as one turn, so every
 * message the harness adds around that prompt — its own context, notifications,
 * and delegated agents' messages — must stay inside the same record. Only a
 * message outside this list is treated as a new prompt. The list is
 * evidence-based: every entry was observed in live DSH transcripts, and an
 * offline audit replays real sessions to keep it aligned. An unknown future
 * wrapper therefore opens one extra record instead of merging two turns.
 */
const injectedContextOpenings: readonly string[] = [
  '<system-reminder>',
  '<openviking-context',
  '<goal_complete>',
  'Current runtime context. This snapshot supersedes earlier runtime-context',
  'This is an automatically generated checkpoint condensing',
  '[model changed:',
  'background job ',
  'The approval policy changed',
]

/**
 * Host messages that name their sender.
 *
 * A delegated agent's message and a settled background subagent both start with
 * a word a subscriber may legitimately use, so they are matched on the host's
 * own template — the sender's identity then a fixed phrase — instead of on a
 * bare prefix that would swallow real prompts.
 */
const hostNotificationTemplate = /^(?:Agent|Background subagent) \S{3,} (?:sent a message:|finished\b)/

/**
 * Text this transport synthesizes while translating a turn's own tool results.
 *
 * A tool result carrying images becomes a user-role message, so it must be
 * recognized as part of the open record rather than as new subscriber input.
 */
const syntheticMarkerTemplate = /^\[\d+ images? returned by the previous tool call\]/

/** Wire text of one user message, used for injection classification. */
function messageText(message: QoderWireMessage): string {
  const content = message.content
  if (typeof content === 'string') return content
  if (content === null) return ''
  return content.map(part => part.type === 'text' ? part.text : '').join('')
}

/** Classify one user-role wire message. */
function qoderMessageOrigin(message: QoderWireMessage): QoderMessageOrigin {
  const text = messageText(message).trimStart()
  if (syntheticMarkerTemplate.test(text)) return 'synthetic'
  if (hostNotificationTemplate.test(text)) return 'injected'
  return injectedContextOpenings.some(opening => text.startsWith(opening)) ? 'injected' : 'prompt'
}

/**
 * Whether one user-role message is host context rather than subscriber input.
 *
 * Exported for the offline audit that checks the opening list against real
 * transcripts, so the list cannot silently drift from what the host appends.
 */
export function isInjectedQoderContext(message: QoderWireMessage): boolean {
  return qoderMessageOrigin(message) !== 'prompt'
}

/** Stable record id of one session turn. */
function turnIdFor(sessionId: string, turnCount: number, anchor: string): string {
  return crypto.createHash('sha256')
    .update('qoder-turn')
    .update('\0')
    .update(sessionId)
    .update('\0')
    .update(String(turnCount))
    .update('\0')
    .update(anchor)
    .digest('hex')
    .slice(0, 16)
}

/**
 * Fingerprint of one message, used to count how often a turn has seen it.
 *
 * Text identifies a message, never an image URL: a published URL is re-signed as
 * its cache entry expires, so a rotating URL would make the turn's own prompt
 * look like new input and split the record. Image count still separates a
 * message that carries images from one that does not.
 */
function messageFingerprint(message: QoderWireMessage): string {
  const hash = crypto.createHash('sha256')
  hash.update(message.role)
  hash.update('\0')
  const content = message.content
  if (typeof content === 'string') {
    hash.update(content)
  } else if (content !== null) {
    let images = 0
    for (const part of content) {
      if (part.type === 'text') {
        hash.update('\0text\0')
        hash.update(part.text)
      } else {
        images += 1
      }
    }
    hash.update(`\0images=${images}`)
  }
  return hash.digest('hex').slice(0, 16)
}

/**
 * Resolves the record identity of the turn one request belongs to.
 *
 * One tracker instance owns its sessions, so tests and transports stay
 * independent. State is created lazily per session and bounded by
 * `maxSessions`.
 */
export class QoderTurnTracker {
  private readonly maxSessions: number
  private readonly idleSessionTtlMs: number
  private readonly now: () => number
  /** Request field the resolved turn id is written to. */
  readonly mode: QoderTurnIdentityMode
  private readonly sessions = new Map<string, SessionTurnState>()

  constructor(options: QoderTurnTrackerOptions = {}) {
    this.maxSessions = options.maxSessions ?? defaultMaxSessions
    this.idleSessionTtlMs = options.idleSessionTtlMs ?? defaultIdleSessionTtlMs
    this.now = options.now ?? Date.now
    this.mode = options.mode ?? 'request-set'
  }

  /**
   * Record id shared by every step of `sessionId`'s current turn.
   *
   * `null` means the request carries no session identity, so no conversation
   * identity can be derived and the caller must fall back to a per-request id.
   */
  resolveTurnRecordId(
    sessionId: string | undefined,
    messages: readonly QoderWireMessage[],
    kind: QoderCallKind = 'conversation',
  ): string | null {
    if (sessionId === undefined || sessionId.length === 0) return null

    let state = this.sessions.get(sessionId)
    if (state === undefined) {
      const now = this.now()
      // Stamp the session before claiming it: the eviction pass must see this
      // conversation as active, otherwise it evicts the entry just created.
      state = {
        claimed: new Map(),
        currentTurnId: '',
        currentBusinessId: '',
        turnOpenedAt: 0,
        lastTouchedAt: now,
        turnCount: 0,
      }
      this.claimSession(sessionId, state)
    } else {
      state.lastTouchedAt = this.now()
      // Refresh recency so eviction drops the coldest conversation.
      this.sessions.delete(sessionId)
      this.sessions.set(sessionId, state)
    }

    // A turn is the multiset of user-role messages it has accounted for. Text
    // identifies a message because the host's own message ids are not part of
    // the wire shape; host-appended context and transport-synthesized markers
    // join the open record, and only newly seen subscriber input opens the next.
    const present = new Map<string, { count: number; host: QoderMessageOrigin }>()
    for (const message of messages) {
      if (message.role !== 'user') continue
      const fingerprint = messageFingerprint(message)
      const entry = present.get(fingerprint)
      if (entry === undefined) {
        present.set(fingerprint, {
          count: 1,
          host: qoderMessageOrigin(message),
        })
      } else {
        entry.count += 1
      }
    }

    let opening: string | undefined
    let unclaimed = 0
    for (const [fingerprint, entry] of present) {
      const claimed = state.claimed.get(fingerprint) ?? 0
      if (entry.count <= claimed) continue
      if (kind === 'conversation') state.claimed.set(fingerprint, entry.count)
      // Host-appended context and transport-synthesized markers join the open
      // record. An unaccounted subscriber message is the only candidate for
      // opening the next one, and exactly one such message means it did.
      if (entry.host === 'injected' || entry.host === 'synthetic') continue
      unclaimed += entry.count - claimed
      opening = fingerprint
    }

    // Forget occurrences this request no longer carries. A message the turn
    // accounted for and that history has since dropped must not mask the same
    // words arriving again as new input, which is exactly what happens when
    // compaction replaces a span and the subscriber repeats their prompt.
    if (kind === 'conversation') {
      for (const fingerprint of [...state.claimed.keys()]) {
        if (!present.has(fingerprint)) state.claimed.delete(fingerprint)
      }
    }

    // Exactly one unaccounted subscriber message opens the next turn, so a
    // subscriber who repeats the same words still gets a record of their own.
    // Anything else — no new input, several at once, or host and transport
    // messages — continues the open record.
    if (kind === 'conversation' && opening !== undefined && unclaimed === 1) {
      state.turnCount += 1
      state.currentTurnId = turnIdFor(sessionId, state.turnCount, opening)
      state.currentBusinessId = crypto.randomUUID()
      state.turnOpenedAt = this.now()
    } else if (kind === 'conversation' && state.currentTurnId === '') {
      // A conversation whose first request carries no subscriber input still
      // belongs to a record; it keeps that record until a real prompt arrives.
      // An auxiliary call opens none: it serves no subscriber turn, and the
      // caller falls back to a per-request identity for it.
      state.turnCount += 1
      state.currentTurnId = turnIdFor(sessionId, state.turnCount, '')
      state.currentBusinessId = crypto.randomUUID()
      state.turnOpenedAt = this.now()
    }

    return state.currentTurnId
  }

  /**
   * Agent-run identity the Qoder service reports consumption against.
   *
   * The official client stamps one `business.id` per agent run and keeps it for
   * every request that run makes, which is what makes one subscriber turn one
   * consumption record. A request outside any conversation still gets its own.
   */
  resolveBusinessId(
    sessionId: string | undefined,
    messages: readonly QoderWireMessage[],
    kind: QoderCallKind = 'conversation',
  ): { businessId: string; beginAt: number } {
    if (sessionId !== undefined && sessionId.length > 0) {
      this.resolveTurnRecordId(sessionId, messages, kind)
      const state = this.sessions.get(sessionId)
      if (state !== undefined && state.currentBusinessId !== '') {
        // An auxiliary call reports a run of its own for exactly this request:
        // adopting it would make the subscriber's own turn inherit the auxiliary
        // call's record once that call returns.
        if (kind === 'auxiliary') return { businessId: crypto.randomUUID(), beginAt: this.now() }
        return { businessId: state.currentBusinessId, beginAt: state.turnOpenedAt }
      }
    }
    return { businessId: crypto.randomUUID(), beginAt: this.now() }
  }

  /** Forget one session, e.g. when its transport is disposed. */
  forget(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  /** Forget every session. */
  clear(): void {
    this.sessions.clear()
  }

  private claimSession(sessionId: string, state: SessionTurnState): void {
    // Re-insert first so the newest conversation is also the most recently used,
    // then keep the recorded sessions bounded.
    this.sessions.set(sessionId, state)
    this.evict()
  }

  /**
   * Keep the recorded sessions bounded.
   *
   * A conversation untouched for longer than the idle TTL cannot still be
   * running a turn, so it is dropped first and dropping it cannot split a
   * record. Sessions are ordered by last touch, which makes that idle set the
   * prefix of the map, so in practice this deletes from the coldest end; the TTL
   * only changes the outcome if the clock moves backwards. Once every recorded
   * conversation is more recent than the TTL, the ceiling drops the coldest one,
   * which can split the turn that conversation was running.
   */
  private evict(): void {
    const idleBefore = this.now() - this.idleSessionTtlMs
    for (const [id, state] of this.sessions) {
      if (this.sessions.size <= this.maxSessions) return
      if (state.lastTouchedAt <= idleBefore) this.sessions.delete(id)
    }
    // Every remaining session is active, so the ceiling wins over protection.
    while (this.sessions.size > this.maxSessions) {
      const oldest = this.sessions.keys().next()
      if (oldest.done === true) return
      this.sessions.delete(oldest.value)
    }
  }
}


