# Identify a Qoder request by its turn, not by its step

A DSH turn issues one model request per reasoning step, turning a single user prompt into dozens of consecutive requests. The Qoder service aggregates resource consumption per agent run: requests sharing a `business.id` appear in the Credits panel as a single record covering the whole turn.

## Identity Mapping

The transport aligns turn identity with Qoder's upstream aggregation model:
- `business.id` & `business.begin_at`: identify an agent run, maintained across every request within a turn to aggregate usage.
- `request_set_id`: carries the same turn identity.
- `chat_record_id` & `request_id`: assigned a unique per-request UUID.
- `session_id`: identifies the conversation session.

## Turn Boundary Derivation

Hosted calls capture an immutable run identity from the committed DSH turn lifecycle before provider I/O. That identity scopes the subscriber/region/session tracker, so a later real turn cannot reuse an earlier turn's request set even if compaction leaves identical input. Within that scope, and for standalone calls without a host owner, `turn-identity.ts` derives request grouping from the multiset of accounted user-role messages:
- An unaccounted subscriber message opens a new turn record.
- Step-level context, background system notifications, synthesized image markers, and trimmed history continue the active turn rather than opening new records.
- Standalone calls without a host run identity can still share the open record for repeated messages whose earlier instances were removed by history compaction, until a distinct message arrives. Hosted calls are separated by their real turn boundary.

## Auxiliary Calls & Lifecycle Isolation

- **Auxiliary host calls** (session titles, history compaction summaries marked by `GenerateOptions.purpose`) run under their own independent agent run. They never open, displace, or claim subscriber turn records.
- **Session tracking**: Turn trackers are bounded in memory, prioritizing the eviction of conversations idle for over an hour to prevent memory leaks while preserving active multi-turn aggregations.
