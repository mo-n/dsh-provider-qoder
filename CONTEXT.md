# DSH Qoder Subscription

This context describes how a Qoder subscription is made available to users through DSH.

## Language

**Qoder provider identity**:
The identity by which DSH selects this third-party integration with a Qoder subscription; it does not imply that Qoder publishes or endorses the plugin.
_Avoid_: official Qoder plugin identity

**Legacy Qoder provider alias**:
A previously published Qoder provider identity accepted for compatibility with existing model selections and callers, without being offered for new selections.
_Avoid_: second Qoder provider, official provider

**Qoder subscription**:
A user's existing Qoder entitlement that permits access to Qoder-hosted language models.
_Avoid_: Qoder API key, generic model subscription

**Qoder personal access token (PAT)**:
A revocable credential representing a Qoder user and carrying permissions selected when the token is created.
_Avoid_: job token, API response token

**Managed Qoder PAT**:
The single Qoder PAT stored for a DSH instance through its managed credential store.
_Avoid_: environment PAT, plugin API key

**Qoder job token**:
A short-lived credential obtained by exchanging a Qoder PAT and used to authorize Qoder model transport requests.
_Avoid_: Qoder PAT, refresh token

**Qoder model key**:
The provider-facing identifier of a Qoder model selected for a request.
_Avoid_: display name, DSH provider route

**Qoder context tier**:
A provider-advertised input-context capacity option for a Qoder model. The provider's default tier and the largest available tier may differ.
_Avoid_: output token limit, maximum context as default

**Qoder transport**:
The provider-side capability that owns Qoder authentication, model discovery, subscriber account reads, model requests, image publication, and web search. It does not own agent tools or workspace operations.
_Avoid_: generic HTTP client, Qoder agent, Qoder Agent SDK

**Qoder multimodal input**:
Text and durable raster-image content accepted together by a Qoder vision-language model; it does not include arbitrary binary files such as PDFs, audio, video, or archives.
_Avoid_: Qoder image upload, arbitrary file upload

**Qoder image publication**:
The exchange that places one request image on the Qoder center service and yields the durable object URL a model request carries in place of inline bytes. It is per subscriber and per Qoder service region, and it degrades to inline content rather than failing the model turn.
_Avoid_: Qoder image upload, attachment sync, CDN push

**Qoder center service**:
The region-scoped Qoder service that owns durable image objects, distinct from the model transport and Open API hosts.
_Avoid_: OSS bucket, image CDN, upload gateway

**Qoder tool exchange**:
The provider-level representation of DSH tool definitions, model-requested tool calls, and correlated tool results transported across Qoder model turns. DSH remains responsible for executing tools.
_Avoid_: Qoder tool execution, Qoder agent loop

**Qoder reasoning content**:
Model-produced reasoning carried separately from user-visible response text, whether Qoder emits it through a dedicated field or embedded thinking tags.
_Avoid_: visible answer, tool output, chain-of-thought configuration

**Qoder reasoning effort**:
An optional, model-specific reasoning level explicitly advertised by Qoder and selected for a conversation. Its identifiers are provider-owned; absence means Qoder chooses its default behavior.
_Avoid_: synthetic off switch, token budget, global reasoning level

**Qoder subscriber profile**:
The verified identity details (user ID, display name, and email) associated with the authenticated Qoder subscription.
_Avoid_: account credential, user token

**Qoder quota usage**:
The point-in-time metrics of a Qoder subscriber's model consumption, remaining allowance, and reset horizon provided by the Qoder service.
_Avoid_: billing balance, token count

**Qoder dedicated resource package**:
An entitlement-scoped allowance carved out of a Qoder subscription that is drawn down ahead of the shared personal quota, such as SOTA credits that only apply to one model series. Each package carries its own size, consumption, expiry, and subscriber-facing copy localized by the provider, and it is reported independently of the organization resource package.
_Avoid_: add-on credits, top-up balance, organization resource pack

**Qoder service region**:
The target service environment (`global` or `china`) of the Qoder platform selected in settings. A Qoder model catalog belongs to exactly one service region and must not be merged with another region's catalog.
_Avoid_: endpoint mode, cluster, server flavor

**Global Qoder service**:
The Qoder service associated with `qoder.com` accounts and international endpoints.
_Avoid_: international endpoint, global cluster

**China Qoder service**:
The Qoder service associated with `qoder.com.cn` accounts and mainland China endpoints.
_Avoid_: domestic service, CN endpoint

**Qoder subscriber plan**:
The subscription tier, term validity, and organization entitlement associated with the authenticated Qoder account.
_Avoid_: subscription level, billing plan

**Qoder subscriber status**:
The operational account standing, security fingerprint linkage, and client feature switches evaluated by Qoder.
_Avoid_: account state, auth flags

**Qoder reasoning preservation**:
The provider-level mechanism that retains prior assistant reasoning content and carries it in the wire message `reasoning_content` across multi-turn exchanges.
_Avoid_: thinking cache, scratchpad replay

**Qoder web search**:
The provider-side web discovery capability available through a Qoder subscription.
_Avoid_: external search, Google search, crawler

**Initiator-aware search routing**:
The provider-level mechanism that inspects the initiating agent's active model provider and routes queries to Qoder when a Qoder model is active, delegating to an ambient search provider otherwise.
_Avoid_: static search provider, fixed search binding

**Qoder settings RPC**:
The exchange between Qoder settings cards and the host that supplies model catalog and subscriber account data.
_Avoid_: remote API client, quota webhook, HTTP proxy

**Qoder agent run**:
One execution of the agent for a single subscriber turn, from the prompt that opened it until the turn ends. Qoder reports consumption for the run as a whole.
_Avoid_: request, step, conversation record, session

**Qoder turn identity**:
The attribution of a Qoder model request to its conversation, agent run, and individual request. See ADR-0009 for the wire fields and aggregation key.
_Avoid_: consumption id, record key, session token

**Qoder auxiliary model call**:
A model request the host makes for its own bookkeeping, such as a session title or compaction summary. It has its own run and does not change a subscriber turn's identity.
_Avoid_: background request, internal call, hidden prompt

**Qoder turn boundary**:
The point at which a new subscriber prompt begins another agent run. See ADR-0009 for how the provider determines this from request history.
_Avoid_: message position, anchor text, step counter
