# Identify a Qoder request by its turn, not by its step

A DSH turn issues one model request per reasoning step, turning a single user prompt into dozens of consecutive requests. The Qoder service aggregates resource consumption per agent run: requests sharing a `business.id` appear in the Credits panel as a single record covering the whole turn.

## Identity Mapping

The transport aligns turn identity with Qoder's upstream aggregation model:
- `business.id` & `business.begin_at`: identify an agent run, maintained across every request within a turn to aggregate usage.
- `request_set_id`: carries the same turn identity.
- `chat_record_id` & `request_id`: assigned a unique per-request UUID.
- `session_id`: identifies the conversation session.

## Turn Boundary Derivation

Hosted calls capture an immutable run handle from the committed DSH turn lifecycle before provider I/O. That handle is the authoritative turn boundary: injected context, history projections, and steering within an open host turn cannot open a second Qoder agent run. A model switch still opens a new Qoder agent run. Subscriber, region, and session identities remain isolated within the handle.

This supersedes message-history inference within a hosted run. The previous combination of host scoping and text inference split real turns whenever the host introduced an unrecognized user-role context message, such as a time snapshot.

Standalone calls without a host owner retain the multiset-based inference in `turn-identity.ts`:
- An unaccounted subscriber message opens a new turn record.
- Recognized step-level context, notifications, synthesized image markers, and trimmed history continue the active turn.
- Repeated messages whose earlier occurrences were replaced by compaction can still share an open record until a distinct message arrives. Hosted calls do not have this ambiguity.

## Auxiliary Calls & Lifecycle Isolation

- **Auxiliary host calls** (session titles, history compaction summaries marked by `GenerateOptions.purpose`) run under their own independent agent run. They never open, displace, or claim subscriber turn records.
- **Hosted tracking**: Transport state is weakly keyed by the captured run handle, outside the standalone LRU cache. The host releases its handle at turn end; outstanding requests retain the old handle until they finish, without joining a newer turn. Completed runs therefore cannot evict active ones, and no global strong reference retains completed run state.
- **Standalone tracking**: The history-inference cache remains bounded, preferring idle conversations when capacity is exceeded.
