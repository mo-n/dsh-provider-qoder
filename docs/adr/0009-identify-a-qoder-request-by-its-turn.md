# Identify a Qoder request by its turn, not by its step

A DSH turn issues one model request per reasoning step, turning a single user prompt into dozens of consecutive requests. The Qoder service aggregates resource consumption per agent run: requests sharing a `business.id` appear in the Credits panel as a single record covering the whole turn.

## Identity Mapping

The transport aligns turn identity with Qoder's upstream aggregation model:
- `business.id` & `business.begin_at`: identify an agent run, maintained across every request within a turn to aggregate usage.
- `request_set_id`: carries the same turn identity.
- `chat_record_id` & `request_id`: assigned a unique per-request UUID.
- `session_id`: identifies the conversation session.

## Turn Boundary Derivation

Because the adapter receives no explicit turn number from DSH, turn boundaries are derived in `turn-identity.ts` based on the multiset of accounted user-role messages:
- An unaccounted subscriber message opens a new turn record.
- Step-level context, background system notifications, synthesized image markers, and trimmed history continue the active turn rather than opening new records.
- Repeated messages whose earlier instances were removed by history compaction will share the open record until a distinct message arrives.

## Auxiliary Calls & Lifecycle Isolation

- **Auxiliary host calls** (session titles, history compaction summaries marked by `GenerateOptions.purpose`) run under their own independent agent run. They never open, displace, or claim subscriber turn records.
- **Session tracking**: Turn trackers are bounded in memory, prioritizing the eviction of conversations idle for over an hour to prevent memory leaks while preserving active multi-turn aggregations.
