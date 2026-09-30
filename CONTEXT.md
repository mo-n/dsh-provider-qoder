# DSH Qoder Subscription

This context defines the ubiquitous language and core conceptual boundaries for accessing Qoder subscription services through DeepSeek Harness (DSH).

## Language

### Identity & Credentials

**Qoder provider identity**:
The identity by which DSH selects this third-party integration with a Qoder subscription; it does not imply that Qoder publishes or endorses the plugin.
_Avoid_: official Qoder plugin identity

**Legacy Qoder provider alias**:
A previously published Qoder provider identity accepted for compatibility with existing model selections and callers, without being offered for new selections.
_Avoid_: second Qoder provider, official provider

**Qoder subscription**:
A user's existing Qoder entitlement that permits access to Qoder-hosted language models.
_Avoid_: Qoder API key, generic model subscription

**Managed Qoder PAT**:
The single Qoder personal access token (PAT) stored and managed for a DSH instance through its credential store.
_Avoid_: environment PAT, plugin API key

**Qoder job token**:
A short-lived credential obtained by exchanging a Qoder PAT and used to authorize model transport requests.
_Avoid_: Qoder PAT, refresh token

**Qoder subscriber profile**:
The verified identity details (user ID, display name, and email) associated with an authenticated Qoder subscription.
_Avoid_: account credential, user token

**Qoder subscriber plan**:
The subscription tier, term validity, and organization entitlements associated with an authenticated account.
_Avoid_: subscription level, billing plan

**Qoder subscriber status**:
The operational account standing, security fingerprint linkage, and client feature switches evaluated by the Qoder service.
_Avoid_: account state, auth flags

### Service & Regions

**Qoder service region**:
The target service environment (`global` or `china`) of the Qoder platform configured in settings. Model catalogs across regions are independent and must not be merged.
_Avoid_: endpoint mode, cluster, server flavor

**Global Qoder service**:
The Qoder service associated with `qoder.com` accounts and international endpoints.
_Avoid_: international endpoint, global cluster

**China Qoder service**:
The Qoder service associated with `qoder.com.cn` accounts and mainland China endpoints.
_Avoid_: domestic service, CN endpoint

**Qoder center service**:
The region-scoped Qoder service that owns durable image storage and web search capabilities, distinct from model transport and Open API hosts.
_Avoid_: OSS bucket, image CDN, upload gateway

### Models & Reasoning

**Qoder model key**:
The provider-facing identifier of a selected Qoder model sent in upstream requests.
_Avoid_: display name, DSH provider route

**Qoder context tier**:
A provider-advertised input-context capacity option for a Qoder model. The provider's default tier and largest available tier may differ.
_Avoid_: output token limit, maximum context as default

**Qoder reasoning content**:
Model-produced reasoning carried separately from user-visible response text, whether emitted through a dedicated field or embedded thinking tags.
_Avoid_: visible answer, tool output, chain-of-thought configuration

**Qoder reasoning effort**:
An optional reasoning level explicitly advertised by the model and configured for a conversation.
_Avoid_: synthetic off switch, token budget, global reasoning level

**Qoder reasoning preservation**:
The mechanism that retains prior assistant reasoning content and carries it forward across multi-turn exchanges.
_Avoid_: thinking cache, scratchpad replay

### Capabilities & Search

**Qoder multimodal input**:
Text and durable raster-image content accepted together by a vision model; it does not include arbitrary binary files such as PDFs, audio, or video.
_Avoid_: Qoder image upload, arbitrary file upload

**Qoder image publication**:
The exchange that uploads a request image to the Qoder center service to obtain a durable URL in place of inline bytes.
_Avoid_: Qoder image upload, attachment sync, CDN push

**Qoder tool exchange**:
The provider-level representation of tool definitions, model tool calls, and execution results transported across model turns. DSH remains responsible for executing tools.
_Avoid_: Qoder tool execution, Qoder agent loop

**Qoder web search**:
The web discovery capability provided by the Qoder center service and authorized via subscriber credentials.
_Avoid_: external search, Google search, crawler

**Qoder search route**:
The center-hosted API path providing structured web search results.
_Avoid_: unifiedSearch, search proxy

**Initiator-aware search routing**:
The routing mechanism that dispatches queries to Qoder when the initiating agent uses a Qoder model, delegating to an ambient search provider otherwise.
_Avoid_: static search provider, fixed search binding

### Transport & Session Lifecycle

**Qoder transport**:
The provider-side capability owning all communication with Qoder, including authentication, model discovery, quota inspection, request translation, and event streaming.
_Avoid_: generic HTTP client, Qoder agent, Qoder Agent SDK

**Qoder settings RPC**:
The loopback communication mechanism used by settings cards to read model catalogs and subscriber account state from the host.
_Avoid_: remote API client, quota webhook, HTTP proxy

**Qoder agent run**:
A single execution cycle of an agent for one subscriber turn, representing the base unit across which the Qoder service aggregates resource consumption.
_Avoid_: request, step, conversation record, session

**Qoder turn identity**:
The composite identifier that correlates a single model request with its conversation and agent run.
_Avoid_: consumption id, record key, session token

**Qoder auxiliary model call**:
A model request the host initiates for internal bookkeeping (such as session title generation or compaction summaries) with an independent lifecycle that does not displace subscriber turn records.
_Avoid_: background request, internal call, hidden prompt
