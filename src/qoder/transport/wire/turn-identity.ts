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
 * Named standalone calls infer boundaries from subscriber messages. Requests
 * without a DSH session use a scoped fixed-time window.
 * Explicit auto review uses a separate scoped fixed-time window; other
 * auxiliary calls always receive independent identities.
 *
 * For inputs without a durable message ID, identical text replacing an earlier
 * occurrence during compaction can share the open record.
 *
 * @module dsh-provider-qoder/qoder/transport/wire/turn-identity
 */

import crypto from 'node:crypto'
import type { QoderHostRun } from '../../turn.ts'
import type { QoderWireMessage, QoderWireTextPart } from './model-types.ts'

export type QoderTurnMessagePart = QoderWireTextPart | { type: 'image_url' }

/** Message shape used for identity, independent of resolved image URLs. */
export interface QoderTurnMessage {
  role: QoderWireMessage['role']
  content: string | null | readonly QoderTurnMessagePart[]
  id?: string
  sourceKind?: string
}

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
  /** Advance this specific run after a usable model or ImageGen result. */
  readonly markStepCompleted: () => void
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
  /** Opening label for a run first reached through image generation. */
  fallbackBusinessName?: string
}

interface SessionTurnState {
  /** Durable message IDs and counts for prompts without an ID. */
  claimed: Map<string, number>
  currentRun?: QoderRunState
  /** When this session last served a request, used only for eviction order. */
  lastTouchedAt: number
  /**
   * Model that opened the current turn. A model switch inside the conversation
   * opens a new agent run and consumption record.
   */
  currentModel?: string
  /** Stable wire session id for this DSH conversation. */
  sessionId: string
}

interface QoderRunState {
  readonly requestSetId: string
  readonly businessId: string
  readonly beginAt: number
  readonly sessionId: string
  readonly businessName: string
  stepCompleted: boolean
}

interface AggregationWindowState {
  readonly expiresAt: number
  readonly run: QoderRunState
}

const defaultMaxSessions = 64
/** A conversation untouched for this long cannot still be mid-turn. */
const defaultIdleSessionTtlMs = 60 * 60 * 1000
const defaultUnscopedWindowTtlMs = 5 * 60 * 1000


/** Extract text without including images. */
export function wireMessageText(message: QoderTurnMessage): string {
  const content = message.content
  if (typeof content === 'string') return content
  if (content === null) return ''
  return content.map(part => part.type === 'text' ? part.text : '').join('')
}

function isSubscriberPrompt(message: QoderTurnMessage): boolean {
  return message.role === 'user' && (message.sourceKind === undefined || message.sourceKind === 'user')
}

function businessName(text: string): string {
  return text.trim().slice(0, 10)
}

/** Use the latest subscriber prompt in the available projection. */
function latestPromptName(messages: readonly QoderTurnMessage[], fallback = ''): string {
  // Hosted requests carry projected history. The latest prompt is the best
  // available boundary-local label when the host does not expose its message id.
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message !== undefined && isSubscriberPrompt(message)) {
      return businessName(wireMessageText(message))
    }
  }
  return businessName(fallback)
}

function openRun(now: number, sessionId: string, name: string): QoderRunState {
  return {
    requestSetId: crypto.randomUUID(),
    businessId: crypto.randomUUID(),
    beginAt: now,
    sessionId,
    businessName: name,
    stepCompleted: false,
  }
}

function resolveRequest(run: QoderRunState, requestId: string): QoderTurnIdentity {
  return {
    requestSetId: run.requestSetId,
    chatRecordId: requestId,
    businessId: run.businessId,
    beginAt: run.beginAt,
    businessStage: run.stepCompleted ? 'processing' : 'start',
    sessionId: run.sessionId,
    businessName: run.businessName,
    markStepCompleted: () => { run.stepCompleted = true },
  }
}

/**
 * Fingerprint of one message, used to count how often a turn has seen it.
 *
 * Text identifies a message, never an image URL: a published URL is re-signed as
 * its cache entry expires, so a rotating URL would make the turn's own prompt
 * look like new input and split the record. Image count still separates a
 * message that carries images from one that does not.
 */
function messageFingerprint(message: QoderTurnMessage): string {
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
  private hosted = new WeakMap<QoderHostRun, Map<string, { modelKey?: string; run: QoderRunState }>>()
  private readonly sessions = new Map<string, SessionTurnState>()
  private readonly aggregationWindows = new Map<string, AggregationWindowState>()
  /** Process-local session mapping survives the bounded five-minute window cache. */
  private readonly aggregationSessionIds = new Map<string, string>()

  constructor(options: QoderTurnTrackerOptions = {}) {
    this.maxSessions = options.maxSessions ?? defaultMaxSessions
    this.idleSessionTtlMs = options.idleSessionTtlMs ?? defaultIdleSessionTtlMs
    this.unscopedWindowTtlMs = options.unscopedWindowTtlMs ?? defaultUnscopedWindowTtlMs
    this.now = options.now ?? (() => Date.now())
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
    messages: readonly QoderTurnMessage[],
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

    if (kind === 'conversation' && !sessionId && hostRun === undefined && resolveOptions.scope !== undefined) {
      return this.resolveAggregationWindow(resolveOptions.scope, modelKey ?? '', requestId, messages, now)
    }

    if (kind !== 'conversation' || !sessionId) {
      const run = openRun(
        now,
        resolveOptions.sessionId ?? crypto.randomUUID(),
        latestPromptName(messages, resolveOptions.fallbackBusinessName),
      )
      return resolveRequest(run, requestId)
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
        lastTouchedAt: now,
        currentModel: modelKey,
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

    const present = new Map<string, number>()
    let opening: QoderTurnMessage | undefined
    for (const message of messages) {
      if (!isSubscriberPrompt(message)) continue
      const id = message.id
      const key = id ? `id:${id}` : `text:${messageFingerprint(message)}`
      const seen = present.get(key) ?? 0
      if (id && seen > 0) continue
      const count = seen + 1
      present.set(key, count)
      if (count > (state.claimed.get(key) ?? 0)) opening = message
    }
    // Dropping claims absent from this projection lets repeated identity-free
    // input open a new run after history compaction.
    state.claimed = present
    if (state.currentRun === undefined || opening !== undefined || modelChanged) {
      const name = opening === undefined
        ? latestPromptName(messages, resolveOptions.fallbackBusinessName)
        : businessName(wireMessageText(opening))
      state.currentRun = openRun(now, state.sessionId, name)
    }
    return resolveRequest(state.currentRun, requestId)

  }

  /** Host boundaries are authoritative; message projections cannot open a new run. */
  private resolveHosted(
    run: QoderHostRun,
    scope: string,
    requestId: string,
    modelKey: string | undefined,
    now: number,
    resolveOptions: QoderTurnResolveOptions,
    messages: readonly QoderTurnMessage[],
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
      return resolveRequest(previous.run, requestId)
    }
    const sessionId = previous?.run.sessionId ?? resolveOptions.sessionId ?? crypto.randomUUID()
    const opened = openRun(now, sessionId, latestPromptName(messages, resolveOptions.fallbackBusinessName))
    scopes.set(scope, { modelKey, run: opened })
    return resolveRequest(opened, requestId)
  }

  /**
   * Record id shared by every step of `sessionId`'s current turn.
   *
   * `null` means the request carries no session identity, so no conversation
   * identity can be derived and the caller must fall back to a per-request id.
   */
  resolveTurnRecordId(
    sessionId: string | undefined,
    messages: readonly QoderTurnMessage[],
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
    messages: readonly QoderTurnMessage[],
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
    messages: readonly QoderTurnMessage[],
    now: number,
    wireSessionId?: string,
  ): QoderTurnIdentity {
    const key = `${scope}\0${modelKey}`
    const previous = this.aggregationWindows.get(key)
    if (previous !== undefined && now < previous.expiresAt) {
      return resolveRequest(previous.run, requestId)
    }

    // The wire session remains stable over multiple windows; only the agent run
    // and request set roll at the fixed boundary.
    let sessionId = this.aggregationSessionIds.get(key)
    if (sessionId === undefined) {
      sessionId = wireSessionId ?? crypto.randomUUID()
      this.aggregationSessionIds.set(key, sessionId)
    }
    const run = openRun(now, sessionId, latestPromptName(messages))
    const window: AggregationWindowState = {
      expiresAt: now + this.unscopedWindowTtlMs,
      run,
    }
    this.aggregationWindows.set(key, window)
    this.evictAggregationWindows(now)
    return resolveRequest(run, requestId)
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


