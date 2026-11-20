# Centralize Qoder upstream access in Qoder transport

All Qoder upstream communication belongs to Qoder transport, exposed through provider capabilities rather than a generic HTTP client. DSH owns registration, configuration, credential storage, and model-generation retries; the transport owns authentication, model discovery, account reads, image publication, and web search. This keeps provider details behind one boundary without duplicating DSH's agent responsibilities.

Each transport instance binds one immutable Qoder service region with its own isolated model catalog. Switching regions replaces the active transport instance while permitting in-flight requests to complete. Connection pools, background polling loops, and circuit breakers remain outside scope; model catalog discovery uses request-driven revalidation rather than autonomous background timers.

## Wire Protocols and Recovery

- **Dual protocol support**: The transport encapsulates both the native COSY model protocol (`legacy`) and the model-server HTTP SSE protocol (`http`), with optional request compression and fallback, presenting a unified interface to the host.
- **Pre-stream authentication recovery**. The transport may refresh subscriber credentials and resend the prepared model request once after an HTTP 401 or an HTTP 403 carrying business code `105`. An HTTP-successful response ends eligibility for authentication recovery, even if the SSE stream fails before producing output.
- **Bounded queue recovery**: The transport handles upstream model queue admission and turn-scoped leases before stream output, mapping exhausted entitlement limits to quota failures while leaving general generation retries to DSH.
- **Tool call commitment**: Streaming tool calls are staged until committed, preventing partial deltas from triggering premature host execution.
