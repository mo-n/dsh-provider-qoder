# Identify a Qoder request by its turn, not by its step

A DSH turn issues one model request per reasoning step, turning a single user prompt into dozens of consecutive requests. The Qoder service aggregates resource consumption per agent run: requests sharing a `business.id` appear in the Credits panel as a single record covering the whole turn.

## Identity Mapping

The transport aligns turn identity with Qoder's upstream aggregation model:
- `business.id` & `business.begin_at`: identify an agent run, maintained across every request within a turn to aggregate usage.
- `request_set_id`: carries the same turn identity.
- `chat_record_id` & `request_id`: assigned a unique per-request UUID.
- `session_id`: identifies the conversation session. Wire session and request-set identifiers are UUID v4 values. Subscriber and service-region isolation remains internal to transport; provider prefixes and host session identifiers are not sent as the wire session ID.
- `business.name`: the opening subscriber prompt truncated to ten JavaScript string characters, retained for the run. Recognized injected context does not replace it. If image generation opens the run before a subscriber prompt is available, its truncated prompt supplies the retained name.

## Turn Boundary Derivation

Hosted calls capture an immutable run handle from the committed DSH turn lifecycle before provider I/O. That handle is the authoritative turn boundary: injected context, history projections, and steering within an open host turn cannot open a second Qoder agent run. A model switch still opens a new Qoder agent run. Subscriber, region, and session identities remain isolated within the handle.

This supersedes message-history inference within a hosted run. The previous combination of host scoping and text inference split real turns whenever the host introduced an unrecognized user-role context message, such as a time snapshot.

Standalone calls without a host owner retain the multiset-based inference in `turn-identity.ts`:
- An unaccounted subscriber message opens a new turn record.
- Recognized step-level context, notifications, synthesized image markers, and trimmed history continue the active turn.
- Repeated messages whose earlier occurrences were replaced by compaction can still share an open record until a distinct message arrives. Hosted calls do not have this ambiguity.

## Auxiliary Calls & Lifecycle Isolation

- **Auxiliary host calls** (session titles and history compaction summaries marked by `GenerateOptions.purpose`) run under their own independent agent run. Explicit `auto-review` calls use a separate aggregation window described below. They never open, displace, or claim subscriber turn records.
- **Hosted tracking**: Transport state is weakly keyed by the captured run handle, outside the standalone LRU cache. The host releases its handle at turn end; outstanding requests retain the old handle until they finish, without joining a newer turn. Completed runs therefore cannot evict active ones, and no global strong reference retains completed run state.
- **Standalone tracking**: The history-inference cache remains bounded, preferring idle conversations when capacity is exceeded.

Wire session UUIDs are mapped in memory for the lifetime of the DSH process and shared by model and image requests. Restarting DSH creates a new upstream session; no credential or identity registry is persisted. Stable UUID mappings deliberately remain until process exit (or tracker clear for no-session scopes): evicting them would silently change session identity. This retains one small mapping per observed DSH conversation and per no-session subscriber/region/model scope, while expired aggregation windows are pruned lazily.

## Fallback and automatic review aggregation

Calls without a host session and without an explicit auxiliary purpose cannot be reliably assigned to a subscriber turn. Older DSH Auto review calls use this path, but transport does not identify them by matching their prompt. Such calls share a Qoder request aggregation window per service region, subscriber, and model. This supersedes the previous per-request identity fallback for these calls only.

Newer DSH hosts supply `sessionId` and `purpose: auto-review`. Treating every purpose as a one-off auxiliary call would bypass fallback aggregation and recreate a business for every tool review. Transport therefore recognizes only the explicit `auto-review` purpose and groups it in a separate review window per service region, subscriber, source conversation (when supplied), and model. A supplied conversation keeps its normal upstream session UUID, while review business and request-set identities remain separate from the main agent run. The captured host run does not open, displace, or claim review identities. Review calls lacking a session also use a review window, isolated from ordinary no-session model calls. This remains compatible with older host type declarations without modifying DSH.

Each window lasts five minutes from its creation; activity does not extend it. It retains one business ID, request-set ID, begin time, and opening name. The upstream session stays stable across window rollover while the business and request-set IDs renew. Every model request still receives its own request ID and matching legacy chat-record ID. A request keeps its captured identity through completion and authentication recovery even if a later request opens a new window.

This grouping deliberately permits calls originating in different DSH conversations to share an upstream consumption identity when their origin is unavailable. It does not combine their messages or recover a real DSH turn boundary, does not change SSE timeouts, and does not reduce token consumption. Explicit title and compaction calls remain independent even without a session. Ordinary hosted and standalone conversations keep their existing boundary rules.

Shared queue admission is accounted for by all concurrent requests using the same request group. One request finishing or being cancelled must not release admission still used by another. Hosted queue leases remain owned by committed host turns. No background release timer or model replay is introduced.

The protocol identity baseline is qodercli 1.1.82. Its native subagent path can inherit a parent's business while using a separate request set; implementing that parent relationship is outside this change. Our hosted child runs remain independent. UUID formatting and offline tests alone do not establish live gateway acceptance or exact Credits-panel presentation.

## Agent-run Finalization

Committed DSH `session/event` `turn/end` finalizes the Qoder agent runs actually
dispatched under its captured host handle. Model-step completion does not close a
run. The host retains transport-owned actions for every business identity,
including earlier model selections and region or subscriber scopes. Replacing an
open host turn or unloading the provider explicitly abandons its remaining runs
with cancellation state; browser authorization remains available until this
bounded cleanup completes.

Qoder transport reports `BUSINESS_FINISH` to
`/algo/api/v2/service/business/finish?Encode=1`, independently of
`/ask/finish` queue lease release and regardless of the selected model protocol.
The encoded, COSY-signed event uses the dispatched session and business identity,
the original agent metadata, and the committed end timestamp. Terminal stages
are `complete`, `abort`, and `error`. An ImageGen call sharing that identity does not create a second report or
replace the agent metadata.

Each region, subscriber, organization, session, and business identity is reported
once per host handle, including across replaced transport instances. Later
matching dispatches may update the captured credential lease. A late request
keeps the closed handle's terminal state and cannot finalize a newer turn.
Reports have an independent ten-second total deadline, including credential
resolution and response cleanup. Only an HTTP 401 or an HTTP 403 carrying explicit
subscriber expiry (`105`) allows one authentication recovery. Failures remain
best effort and do not change the subscriber's model result.

Auxiliary model calls remain isolated and do not register subscriber finalization.
Standalone calls inferred from history lack an authoritative completion event and
therefore do not report automatic agent-run finalization.
