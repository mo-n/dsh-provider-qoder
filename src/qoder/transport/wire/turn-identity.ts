/**
 * Per-turn Qoder request identity.
 *
 * A DSH turn issues one model request per reasoning step, so a single
 * subscriber prompt becomes dozens of consecutive Qoder requests. Qoder's
 * Credits panel aggregates consumption per agent run — the `business.id` a
 * request reports — so every step of one turn must carry the same run identity
 * while the next subscriber prompt opens a new one.
 *
 * Hosted calls use a captured host run as their authoritative boundary. The
 * weakly owned identity survives history projections and standalone-cache eviction.
 * Named standalone calls infer boundaries from the multiset of user-role
 * messages; requests without a DSH session use a scoped fixed-time window.
 * Explicit auto review uses a separate scoped fixed-time window; other
 * auxiliary calls always receive independent identities.
 *
 * Standalone limit: text identifies a message because wire messages lack host
 * message IDs. Identical input replacing an earlier occurrence during compaction
 * can share the open record. Hosted calls use real boundaries instead.
 *
 * @module dsh-provider-qoder/qoder/transport/wire/turn-identity
 */

import crypto from 'node:crypto'
import type { QoderHostRun } from '../../turn.ts'
import type { QoderWireMessage } from './model-types.ts'

/**
 * Resolved identity fields for a Qoder wire request.
 */
export interface QoderTurnIdentity {
  readonly requestSetId: string
  readonly chatRecordId: string
  readonly businessId: string
  readonly beginAt: number
  readonly businessStage: 'start' | 'processing'
  /** Stable wire session identity for the resolved request group. */
  readonly sessionId: string
  /** First subscriber prompt used for the Qoder Credits task label. */
  readonly businessName: string
}

/**
 * What a request is for.
 *
 * A conversation request continues, or opens, a subscriber turn. The host also
 * routes its own auxiliary calls — session title, compaction summary — through
 * the same provider with the same session identity but a message list of their
 * own, and those must never move a turn's boundary.
 */
export type QoderCallKind = 'conversation' | 'auxiliary' | 'auto-review'

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
  /** Fixed lifetime for fallback and auto-review aggregation windows. */
  unscopedWindowTtlMs?: number
}

/** Optional wire context supplied by the request preparation layer. */
export interface QoderTurnResolveOptions {
  /** Region/subscriber scope used for requests without a DSH session id. */
  scope?: string
  /** Pre-resolved wire session id for a named DSH session. */
  sessionId?: string
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
  /**
   * Model that opened the current turn. A model switch inside the conversation
   * opens a new agent run and consumption record.
   */
  currentModel?: string
  /** First subscriber prompt shown in the Qoder Credits panel. */
  currentBusinessName: string
  /** Stable wire session id for this DSH conversation. */
  sessionId: string
}

interface AggregationWindowState {
  readonly expiresAt: number
  readonly identity: QoderTurnIdentity
}

const defaultMaxSessions = 64
/** A conversation untouched for this long cannot still be mid-turn. */
const defaultIdleSessionTtlMs = 60 * 60 * 1000
const defaultUnscopedWindowTtlMs = 5 * 60 * 1000


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
  'Time sampled while preparing turn ',
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
 * Compatibility with image markers synthesized by older transport versions.
 *
 * Current tool images stay in tool-role messages. Historical user-role markers
 * still belong to the open record rather than to new subscriber input.
 */
const syntheticMarkerTemplate = /^\[\d+ images? returned by the previous tool call\]/

/** Wire text of one user message, used for injection classification and text extraction. */
export function wireMessageText(message: QoderWireMessage): string {
  const content = message.content
  if (typeof content === 'string') return content
  if (content === null) return ''
  return content.map(part => part.type === 'text' ? part.text : '').join('')
}

/** Classify one user-role wire message. */
function qoderMessageOrigin(message: QoderWireMessage): QoderMessageOrigin {
  const text = wireMessageText(message).trimStart()
  if (syntheticMarkerTemplate.test(text)) return 'synthetic'
  if (hostNotificationTemplate.test(text)) return 'injected'
  return injectedContextOpenings.some(opening => text.startsWith(opening)) ? 'injected' : 'prompt'
}

/** First subscriber prompt used for the upstream business task label. */
function firstPromptName(messages: readonly QoderWireMessage[]): string {
  // Hosted requests carry projected history. The latest prompt is the best
  // available boundary-local label when the host does not expose its message id.
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.role === 'user' && qoderMessageOrigin(message) === 'prompt') {
      return wireMessageText(message).slice(0, 10)
    }
  }
  return ''
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
 * Standalone session state is bounded by `maxSessions`. Hosted state is weakly
 * owned by its run handle, which the host and outstanding requests keep alive.
 */
export class QoderTurnTracker {
  private readonly maxSessions: number
  private readonly idleSessionTtlMs: number
  private readonly unscopedWindowTtlMs: number
  private readonly now: () => number
  // Weak ownership keeps active/late requests stable without retaining completed runs.
  private hosted = new WeakMap<QoderHostRun, Map<string, { modelKey?: string; identity: QoderTurnIdentity }>>()
  private readonly sessions = new Map<string, SessionTurnState>()
  private readonly aggregationWindows = new Map<string, AggregationWindowState>()
  /** Process-local session mapping survives the bounded five-minute window cache. */
  private readonly aggregationSessionIds = new Map<string, string>()

  constructor(options: QoderTurnTrackerOptions = {}) {
    this.maxSessions = options.maxSessions ?? defaultMaxSessions
    this.idleSessionTtlMs = options.idleSessionTtlMs ?? defaultIdleSessionTtlMs
    this.unscopedWindowTtlMs = options.unscopedWindowTtlMs ?? defaultUnscopedWindowTtlMs
    this.now = options.now ?? Date.now
    if (!Number.isFinite(this.unscopedWindowTtlMs) || this.unscopedWindowTtlMs <= 0) {
      throw new Error('unscopedWindowTtlMs must be a positive finite number')
    }
  }

  /**
   * Resolves the full wire identity for one Qoder request.
   *
   * Coordinates `request_set_id`, `chat_record_id`, and `business` metadata so
   * that requests within one subscriber turn share a single agent run and
   * consumption record.
   */
  resolveTurnIdentity(
    sessionId: string | undefined,
    messages: readonly QoderWireMessage[],
    kind: QoderCallKind = 'conversation',
    requestId = crypto.randomUUID(),
    modelKey?: string,
    hostRun?: QoderHostRun,
    resolveOptions: QoderTurnResolveOptions = {},
  ): QoderTurnIdentity {
    const now = this.now()

    // Explicit review calls have their own fixed-time grouping. A supplied DSH
    // session isolates reviews from other conversations; the captured host run
    // must not let reviews open or claim the main conversation identity.
    if (kind === 'auto-review' && resolveOptions.scope !== undefined) {
      return this.resolveAggregationWindow(
        JSON.stringify(['auto-review', resolveOptions.scope, sessionId ?? null]),
        modelKey ?? '', requestId, messages, now, resolveOptions.sessionId,
      )
    }

    if (sessionId === undefined || sessionId.length === 0) {
      if (kind === 'conversation' && hostRun === undefined && resolveOptions.scope !== undefined) {
        return this.resolveAggregationWindow(resolveOptions.scope, modelKey ?? '', requestId, messages, now)
      }
      const independentSessionId = resolveOptions.sessionId ?? crypto.randomUUID()
      return {
        requestSetId: crypto.randomUUID(),
        chatRecordId: requestId,
        businessId: crypto.randomUUID(),
        beginAt: now,
        businessStage: 'start',
        sessionId: independentSessionId,
        businessName: firstPromptName(messages),
      }
    }

    if (kind === 'auxiliary' || kind === 'auto-review') {
      if (this.sessions.has(sessionId)) {
        this.sessions.get(sessionId)!.lastTouchedAt = now
      }
      return {
        requestSetId: crypto.randomUUID(),
        chatRecordId: requestId,
        businessId: crypto.randomUUID(),
        beginAt: now,
        businessStage: 'start',
        sessionId: resolveOptions.sessionId ?? crypto.randomUUID(),
        businessName: firstPromptName(messages),
      }
    }

    if (hostRun !== undefined) {
      return this.resolveHosted(hostRun, sessionId, requestId, modelKey, now, resolveOptions, messages)
    }

    let state = this.sessions.get(sessionId)
    if (state === undefined) {
      // Stamp the session before claiming it: the eviction pass must see this
      // conversation as active, otherwise it evicts the entry just created.
      state = {
        claimed: new Map(),
        currentTurnId: '',
        currentBusinessId: '',
        turnOpenedAt: 0,
        lastTouchedAt: now,
        turnCount: 0,
        currentModel: modelKey,
        currentBusinessName: '',
        sessionId: resolveOptions.sessionId ?? crypto.randomUUID(),
      }
      this.claimSession(sessionId, state)
    } else {
      state.lastTouchedAt = now
      // Refresh recency so eviction drops the coldest conversation.
      this.sessions.delete(sessionId)
      this.sessions.set(sessionId, state)
    }

    const modelChanged = state.currentModel !== undefined && modelKey !== undefined && state.currentModel !== modelKey
    if (modelKey !== undefined) {
      state.currentModel = modelKey
    }

    // A turn is the multiset of user-role messages it has accounted for. Text
    // identifies a message because the host's own message ids are not part of
    // the wire shape; host-appended context and transport-synthesized markers
    // join the open record, and only newly seen subscriber input opens the next.
    const present = new Map<string, { count: number; host: QoderMessageOrigin; text: string }>()
    for (const message of messages) {
      if (message.role !== 'user') continue
      const fingerprint = messageFingerprint(message)
      const entry = present.get(fingerprint)
      if (entry === undefined) {
        present.set(fingerprint, {
          count: 1,
          host: qoderMessageOrigin(message),
          text: wireMessageText(message),
        })
      } else {
        entry.count += 1
      }
    }

    let opening: string | undefined
    let openingName = ''
    let unclaimed = 0
    for (const [fingerprint, entry] of present) {
      const claimed = state.claimed.get(fingerprint) ?? 0
      if (entry.count <= claimed) continue
      state.claimed.set(fingerprint, entry.count)
      // Host-appended context and transport-synthesized markers join the open
      // record. An unaccounted subscriber message is the candidate for opening
      // the next one.
      if (entry.host === 'injected' || entry.host === 'synthetic') continue
      unclaimed += entry.count - claimed
      if (opening === undefined && entry.host === 'prompt') {
        opening = fingerprint
        openingName = entry.text.slice(0, 10)
      }
    }

    // Forget occurrences this request no longer carries. A message the turn
    // accounted for and that history has since dropped must not mask the same
    // words arriving again as new input, which is exactly what happens when
    // compaction replaces a span and the subscriber repeats their prompt.
    // If the count of a claimed fingerprint decreased, clamp it down to present.count.
    for (const [fingerprint, claimed] of state.claimed) {
      const current = present.get(fingerprint)
      if (current === undefined) {
        state.claimed.delete(fingerprint)
      } else if (current.count < claimed) {
        state.claimed.set(fingerprint, current.count)
      }
    }

    // Any unaccounted subscriber message or model switch opens the next turn, so a
    // subscriber who sends multiple messages, repeats words, or switches models
    // gets a distinct agent run and consumption record.
    let businessStage: 'start' | 'processing' = 'processing'
    if ((opening !== undefined && unclaimed > 0) || modelChanged) {
      businessStage = 'start'
      state.turnCount += 1
      state.currentTurnId = crypto.randomUUID()
      state.currentBusinessId = crypto.randomUUID()
      state.turnOpenedAt = now
      state.currentBusinessName = openingName || firstPromptName(messages)
    } else if (state.currentTurnId === '') {
      // A conversation whose first request carries no subscriber input still
      // belongs to a record; it keeps that record until a real prompt arrives.
      businessStage = 'start'
      state.turnCount += 1
      state.currentTurnId = crypto.randomUUID()
      state.currentBusinessId = crypto.randomUUID()
      state.turnOpenedAt = now
      state.currentBusinessName = firstPromptName(messages)
    }

    return {
      requestSetId: state.currentTurnId,
      chatRecordId: requestId,
      businessId: state.currentBusinessId,
      beginAt: state.turnOpenedAt,
      businessStage,
      sessionId: state.sessionId,
      businessName: state.currentBusinessName,
    }
  }

  /** Host boundaries are authoritative; message projections cannot open a new run. */
  private resolveHosted(
    run: QoderHostRun,
    scope: string,
    requestId: string,
    modelKey: string | undefined,
    now: number,
    resolveOptions: QoderTurnResolveOptions,
    messages: readonly QoderWireMessage[],
  ): QoderTurnIdentity {
    let scopes = this.hosted.get(run)
    if (scopes === undefined) {
      scopes = new Map()
      this.hosted.set(run, scopes)
    }
    const previous = scopes.get(scope)
    const modelChanged = previous?.modelKey !== undefined && modelKey !== undefined && previous.modelKey !== modelKey
    if (previous !== undefined && !modelChanged) {
      if (modelKey !== undefined) previous.modelKey = modelKey
      const businessName = previous.identity.businessName || firstPromptName(messages)
      if (businessName !== previous.identity.businessName) {
        previous.identity = { ...previous.identity, businessName }
      }
      return { ...previous.identity, chatRecordId: requestId, businessStage: 'processing' }
    }
    const sessionId = previous?.identity.sessionId ?? resolveOptions.sessionId ?? crypto.randomUUID()
    const identity: QoderTurnIdentity = {
      requestSetId: crypto.randomUUID(),
      chatRecordId: requestId,
      businessId: crypto.randomUUID(),
      beginAt: now,
      businessStage: 'start',
      sessionId,
      businessName: firstPromptName(messages),
    }
    scopes.set(scope, { modelKey, identity })
    return identity
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
    return this.resolveTurnIdentity(sessionId, messages, kind).requestSetId
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
    const identity = this.resolveTurnIdentity(sessionId, messages, kind)
    return { businessId: identity.businessId, beginAt: identity.beginAt }
  }

  /** Forget one standalone session. Hosted state follows its run handle lifetime. */
  forget(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  /** Forget every session. */
  clear(): void {
    this.sessions.clear()
    this.aggregationWindows.clear()
    this.aggregationSessionIds.clear()
    this.hosted = new WeakMap()
  }

  /** Resolve a fixed five-minute identity window for fallback or review calls. */
  private resolveAggregationWindow(
    scope: string,
    modelKey: string,
    requestId: string,
    messages: readonly QoderWireMessage[],
    now: number,
    wireSessionId?: string,
  ): QoderTurnIdentity {
    const key = `${scope}\0${modelKey}`
    const previous = this.aggregationWindows.get(key)
    if (previous !== undefined && now < previous.expiresAt) {
      return { ...previous.identity, chatRecordId: requestId, businessStage: 'processing' }
    }

    // The wire session remains stable over multiple windows; only the agent run
    // and request set roll at the fixed boundary.
    let sessionId = this.aggregationSessionIds.get(key)
    if (sessionId === undefined) {
      sessionId = wireSessionId ?? crypto.randomUUID()
      this.aggregationSessionIds.set(key, sessionId)
    }
    const identity: QoderTurnIdentity = {
      requestSetId: crypto.randomUUID(),
      chatRecordId: requestId,
      businessId: crypto.randomUUID(),
      beginAt: now,
      businessStage: 'start',
      sessionId,
      businessName: firstPromptName(messages),
    }
    const window: AggregationWindowState = {
      expiresAt: now + this.unscopedWindowTtlMs,
      identity,
    }
    this.aggregationWindows.set(key, window)
    this.evictAggregationWindows(now)
    return identity
  }

  /** Prune only expired windows; an active window must survive scope pressure. */
  private evictAggregationWindows(now: number): void {
    for (const [key, window] of this.aggregationWindows) {
      if (window.expiresAt <= now) this.aggregationWindows.delete(key)
    }
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


