# Centralize Qoder upstream access in Qoder transport

All Qoder upstream communication belongs to Qoder transport, exposed through provider capabilities rather than a generic HTTP client. DSH owns registration, configuration, credential storage, and model-generation retries; the transport owns authentication and Qoder protocol behavior. This keeps provider details behind one boundary without duplicating DSH's agent responsibilities.

Each transport instance binds one immutable Qoder service region. Model catalogs are configured and persisted separately by region; switching region replaces the active instance while allowing already-started requests to finish. Shared reads use last-waiter cancellation, and internal metadata retries are limited to idempotent reads.

The original capabilities were model streaming, model discovery, and account reading. [ADR-0004](0004-publish-qoder-multimodal-input-through-the-center-service.md) adds image publication inside model-request preparation, and [ADR-0006](0006-route-web-search-by-initiating-model.md) adds web search. Both preserve the same ownership boundary; authentication refresh and retry behavior for those operations are defined separately from model-generation retries.

Connection pools, background refresh, circuit breakers, dynamic rate limiting, and full tracing remain outside scope until demonstrated needs justify them.

## Authentication recovery before model generation

Qoder transport may refresh subscriber credentials once after an HTTP 401/403
rejection received before a model SSE stream starts, matching qodercli. This is a
protocol authentication exchange: the prepared model body, request ID and turn
identity are reused. Duplicate-request 403 responses (upstream code `103`) are
not treated as expired credentials. Model business errors are decoded before
recovery: known quota, queue and other non-authentication rejections, as well as
explicit unknown business codes, do not refresh credentials. Explicit subscriber
authentication expiry (`105`) or an unclassified HTTP 401/403 may refresh once;
custom model authentication failures do not refresh subscriber credentials.
A second rejection is returned to DSH.
Transport never replays an HTTP-successful model stream after an authentication or quota error. Queue recovery before any model output is owned by transport using turn-scoped leases; ordinary model-generation retries remain DSH-owned. This narrowly extends the original idempotent-read retry restriction.

Model HTTP and SSE rejections share business-error classification. Queue code
`10605` is consumed by transport queue recovery and maps to `RATE_LIMIT` only
when queue recovery is disabled; exhausted quota and entitlement limits map to
`QUOTA`. Provider delay hints retain the greater valid body/header delay without
clamping to force recovery. Transport owns bounded queue recovery, while terminal
queue failures use dedicated codes outside DSH's default transient retry set.
Ordinary failure delay hints still follow DSH's retry policy.
Other transport capabilities retain their own error protocols. DSH owns the
existing retry and generic quota presentation, while transport diagnostics retain
the concrete upstream code and distinguish HTTP status from SSE business status.

## Model-server HTTP and legacy model transport

The model transport defaults to the COSY `/algo/` model protocol (`legacy`).
Qoder's model-server HTTP SSE protocol with a Bearer subscriber token remains
selectable as `http`. These are separate wire protocols; both remain inside Qoder transport.
Model discovery, account reads, image publication, and web search continue to use
their independently verified endpoints and authentication formats.

Qoder transport owns one auth manager per region-bound instance. It exchanges the
Managed Qoder PAT, merges concurrent refreshes, rejects stale credential results,
and performs at most one same-protocol recovery before a model stream starts.
An HTTP-successful stream is never replayed after a later authentication or quota
error. Model protocols are switched only by explicit subscriber configuration.
Legacy queue recovery before output retains the turn-scoped lease behavior above;
ordinary model-generation retries remain DSH-owned.
Refresh remains request-driven, so this decision does not introduce a background
refresh timer.

Zstd request-body compression is disabled by default. Subscribers can opt in
through the YAML setting `requestCompression: true`; the provider does not consume
the CLI's remote compression feature gate. Model transport is also configured only
through YAML.
