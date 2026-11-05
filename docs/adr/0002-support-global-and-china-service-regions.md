# Support Global and China service regions via settings configuration

We support both Global (`qoder.com`) and China (`qoder.com.cn`) Qoder service regions via a single `region` setting in the `provider-qoder` namespace, rather than requiring manual endpoint entry or maintaining separate provider plugins.

While both regions share the same underlying COSY authentication algorithm and request payload formats, they operate on separate network endpoints and host distinct model catalogs.

Storing `region` in DSH settings preserves a single Managed Qoder PAT credential while allowing subscribers to switch environments, flush in-memory job tokens, and dynamically discover the model catalog corresponding to their active region.

The effective settings namespace is the owning Loader entry's `options.id`, so an embedding application can mount the provider under a custom entry id without splitting host persistence from the client form. The historical `provider-qoder` id remains the compatibility default only when no entry id is available. The client obtains the effective namespace through the host bootstrap RPC before resolving its config form; credential references and region identities remain unchanged.

Bootstrap retries transient connection failures, HTTP 429/5xx and timeouts up to
three attempts, with a five-second deadline per attempt and cancellable backoff.
Permission and contract failures never select a fallback namespace. Exhausted
recovery fails initialization; reloading the client/plugin can start it again.
