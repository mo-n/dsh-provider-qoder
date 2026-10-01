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
Transport never retries an HTTP-successful model stream, including one that
emits a later authentication or quota error. DSH continues to own model-generation
retries. This narrowly extends the original idempotent-read retry restriction.

Model HTTP and SSE rejections share business-error classification. Queue code
`10605` alone maps to `RATE_LIMIT`; exhausted quota and entitlement limits map to
`QUOTA`. Provider delay hints retain the greater valid body/header delay without
clamping to force recovery. The plugin does not override DSH's default retry
policy or add a queue loop; DSH may decline a delay exceeding its policy cap.
Other transport capabilities retain their own error protocols. DSH owns the
existing retry and generic quota presentation, while transport diagnostics retain
the concrete upstream code and distinguish HTTP status from SSE business status.
