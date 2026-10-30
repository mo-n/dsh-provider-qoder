# Route web search by initiating agent model

We implement Qoder web search as an initiator-aware search provider within `dsh-provider-qoder`. By default (`webSearchMode: 'auto'`), search queries inspect the initiating agent's model provider: turns using a Qoder model (`dsh-provider-qoder`) execute against the Qoder center service's `oneSearch` route authorized by the subscriber's COSY credentials; turns using non-Qoder models delegate to the ambient search provider.

A dedicated `webSearchMode` setting allows users to choose between `'auto'` (model-aware delegation), `'always'` (route all searches through Qoder), and `'disabled'` (disable Qoder search participation). Requests automatically refresh credentials and retry once on HTTP 401/403 status codes.

The transparent wrapper sends eligible calls directly to Qoder, even when the host explicitly configures another provider. All other calls invoke the original host search method. Qoder's `available()` uses the same mode and initiating-model rule, and execution rechecks eligibility. Without an initiating provider, the formal `agentDefaultModel.currentSelection()` supplies the default. The provider never enumerates the host's private registry or selects a fallback itself.

In `auto`, non-Qoder calls see Qoder as unavailable, avoiding recursive selection and ambiguity caused by Qoder itself. The host retains configured-provider errors and zero/one/multiple ambient-provider selection. Explicit `searchProvider: qoder` with a non-Qoder model therefore reports `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`; subscribers wanting Qoder for every model choose `always`. `disabled` delegates all calls to the host. Genuine ambiguity among ambient providers remains a host error.

Direct calls retain the host result limit and cancellation signal. Disposal restores the original public search method without overwriting a later wrapper. Because Cordis traces service methods with fresh proxies on reads, ownership is checked using the public method's property descriptor, not function identity from a service read.
