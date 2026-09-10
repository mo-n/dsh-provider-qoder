# DSH Qoder Subscription

This context describes how a Qoder subscription is made available to users through DSH.

## Language

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
The provider-side capability that owns all communication with Qoder: authenticating a subscriber, discovering models, reading subscriber profile and quota, translating model requests, and returning model stream events. It does not own agent tools or workspace operations.
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

**Quick validation release**:
The first public release whose purpose is to prove that DSH can use a Qoder subscription for streaming text, reasoning, and tool-driven model turns.
_Avoid_: MVP, feature-complete release

**Public release**:
A distributable plugin release intended for installation by Qoder subscribers beyond the maintainers' own machines.
_Avoid_: local prototype, internal build

**Qoder subscriber profile**:
The verified identity details (user ID, display name, and email) associated with the authenticated Qoder subscription.
_Avoid_: account credential, user token

**Qoder quota usage**:
The point-in-time metrics of a Qoder subscriber's model consumption, remaining allowance, and reset horizon provided by the Qoder service.
_Avoid_: billing balance, token count

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
