# Carry the settings RPC on Connection exact Fetch routes

## Context

The Qoder credential card and account card read models and subscriber quota
through a dedicated Connection channel, `/qoder-subscription`, registered with
`connection.rpc.handle(channel, handler)` from a `ctx.inject(['webServer'], …)`
scope.

`HostConnectionService.register()` resolves the route target as
`owner.effect(() => owner.webServer.register(route))`, where
`owner = this.ctx` is the **connection plugin's own** context — not the calling
plugin's. In `dsh-client-connection` 0.1.2-rc.1 that context injected
`webServer`, so the lookup succeeded. In 0.1.5-rc.2 the plugin injects only
`credentials` and reaches `webServer` from a child context, so every
`rpc.handle` call throws:

```
Error: cannot get property "webServer" without inject
    at HostConnectionService.register (…/dsh-client-connection/lib/index.js:618)
```

The channel is therefore never mounted. A browser request to
`/qoder-subscription/account` misses the route table and falls through to the
static frontend handler, which answers non-`GET`/`HEAD` with **405** — surfaced
in DSH as `transport failure for /qoder-subscription/account: HTTP 405`. Because
plugin boot is fail-loud, the throw also aborted the rest of `apply()`, so the
web-search provider registered after it never loaded. Consumer-side scoping
cannot fix this: wrapping the call in `ctx.inject(['webServer'], …)` still
throws, because the failing lookup belongs to the service, not to the reader.

## Decision

The two settings endpoints are mounted as Connection **exact Fetch routes** on
the shared `/api` channel, which the connection plugin mounts itself:

- `/api/qoder-subscription/account`
- `/api/qoder-subscription/models`

Both are `POST` with a buffered JSON body, registered through
`connection.fetch.register()`. That registry only writes the service's own route
map, never resolving `webServer`, and it is the surface DSH's own file-upload
plugin uses. Connection's `/api` route keeps applying its Host/Origin fence and
browser authentication before dispatch, so the routes are exactly as protected
as the channel was.

The wire contract is a standard result envelope — `{ ok: true, value }` or
`{ ok: false, error: { code, message } }` — instead of the Connection client-request
envelope, because the calling half builds its own request with `fetch`. The 405 diagnostic
is preserved verbatim so a future transport failure stays recognizable.

The client half therefore no longer needs the `connection` client service, and
the host half no longer needs `webServer`.

## Consequences

The plugin is decoupled from the `rpc.handle` defect: it registers and serves on
both `dsh-client-connection` 0.1.2-rc.1 and 0.1.5-rc.2 (verified against both
runtimes: registration succeeds, the shared handler dispatches both endpoints,
unknown paths and wrong methods stay 404).

Route registration is wrapped in a caught effect and logged instead of
propagating: the settings RPC is an optional surface, and a future Connection
change may not take the model adapter and web-search router down with it again.

The endpoints now live on the shared channel, so they inherit its body limit and
its trust fence rather than owning a private prefix. DSH's failing `rpc.handle`
is left untouched — this ADR records a workaround, not an upstream fix; the
defect is reported upstream separately.
