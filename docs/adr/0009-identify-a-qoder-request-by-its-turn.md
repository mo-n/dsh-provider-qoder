# Identify a Qoder request by its turn, not by its step

A DSH turn can issue multiple model requests for a single subscriber prompt. The Qoder service aggregates resource consumption per Qoder agent run, so successive requests in the same run share one Credits record.

## Turn Boundary and Identity Mapping

The transport aligns turn identity with Qoder's upstream aggregation model:
- **Authoritative boundary**: Hosted calls capture an immutable run handle from the committed DSH turn lifecycle before provider I/O. Injected context, history projections, or steering within an open host turn cannot split the Qoder agent run. Standalone calls without a host owner infer turn boundaries from DSH user-role messages.
- **Identity allocation**. Model requests within the same Qoder agent run share `business.id`, `business.begin_at`, and `request_set_id`. Each request receives a unique `request_id` and matching legacy `chat_record_id`. Changing the Qoder model key within a DSH turn starts a new Qoder agent run and preserves `session_id`. Later requests in the same run use `processing` after its first successful step.

## Auxiliary Calls and Isolation

- **Auxiliary host calls** (session titles, history compaction, and explicit `auto-review` calls) run under independent agent runs or bounded review aggregation windows. They never open, displace, or claim subscriber turn records.
- **Fallback aggregation**: Calls lacking host session context share a bounded request aggregation window per service region, subscriber, and model, preventing unbounded business creation while keeping model calls isolated from subscriber turns.

## Agent-run Finalization

A committed DSH turn end (`turn/end`) finalizes the Qoder agent runs dispatched under its captured host handle, independently of queue lease release. The transport reports terminal state (`complete`, `abort`, or `error`) upstream via a best-effort, signed `BUSINESS_FINISH` event. Auxiliary and history-inferred standalone calls do not emit automatic agent-run finalization.
