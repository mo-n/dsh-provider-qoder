# Expose Qoder image capabilities through DSH tools

We expose Qoder image search and image generation as native DSH tools, `ImageSearch` and `ImageGen`, so subscribers can use these capabilities with the provider's existing authorization and service-region configuration. This extends the authentication/model-only scope in [ADR-0001](0001-keep-qoder-behind-the-dsh-llm-boundary.md), while preserving DSH's ownership of the agent loop, tool execution, cancellation, and permission policy. Qoder transport owns upstream authentication, signing, requests, and generated-image downloads under [ADR-0003](0003-centralize-qoder-upstream-access-in-qoder-transport.md).

## Considered options

- Keep the provider limited to authentication and model transport, leaving image capabilities to a separate plugin. This preserves the original scope, but a separate plugin would need an authorization and region-sharing boundary or duplicate that integration. Native DSH tools reuse the existing Qoder transport without introducing another agent loop.
- Embed the Qoder Agent SDK to obtain its tools. Its execution and workspace responsibilities overlap DSH's, retaining the ownership problem identified in ADR-0001. We expose only the upstream capabilities needed by DSH tools.
- Save generated images directly into a requested workspace directory. The DSH filesystem interface targeted by this decision has no binary write operation; host filesystem writes cannot stand in for writes in an arbitrary execution environment. We use DSH's durable attachment storage and map its host path into the execution environment instead.
- Return only the generated upstream URL. This avoids local persistence but makes delivery depend on continued upstream URL availability and does not provide a durable DSH attachment. We download and preserve the original bytes before reporting successful delivery.

## Delivery and failure semantics

DSH owns attachment persistence and execution-environment path mapping; Qoder transport returns the downloaded image bytes. A successful `ImageGen` result includes a durable file attachment and an absolute execution-environment read path. This does not promise that the image is written into the workspace or to an arbitrary caller-selected destination. `ImageSearch` returns image and source metadata without downloading search results.

Generation submissions are not replayed after uncertain failures: a timeout, connection failure, or unusable response does not establish that Qoder rejected the operation. Repeating it could create another image and consume subscriber quota again. The narrow authentication-recovery exception is an explicit HTTP 401 rejection: transport may refresh credentials once and resubmit the same request body and request ID. HTTP 403 and uncertain failures do not trigger that recovery; model-generation retry rules do not apply to image tools.

Once Qoder has returned an image URL, download, validation, storage, or path-mapping failures are reported as delivery failures, with a request ID and instructions against automatic regeneration. No automatic delivery-recovery operation is currently exposed; retaining a request ID is diagnostic correlation, not a guarantee that the image can be recovered. Signed image URLs must not appear in ordinary diagnostics.

## Consequences

- Image capabilities share the provider's selected Qoder authorization and service region. They have independent live enable/disable settings; their availability is not restricted to turns using a Qoder language model. The initiator-aware web search modes in [ADR-0006](0006-route-web-search-by-initiating-model.md) retain their existing behavior.
- Generation is registered only when transport generation, attachment persistence, and host-to-execution path-mapping APIs are available. Even then, mapping a particular saved attachment can fail after generation; a host without usable mapping cannot fulfill the delivery contract. Image search can remain available independently.
- Disabling a capability removes its tool definition and rejects retained calls at execution entry. It does not cancel calls already in progress; DSH remains responsible for caller cancellation and tool policy.
- Generating an image does not require the calling language model to accept image input. Inspecting the resulting image is a separate capability, provided by DSH's existing `read_image` tool when available. This decision adds neither an image-reading implementation nor video tools.
- Downloading upstream image URLs adds transport security responsibilities: bound resource use, validate download destinations and redirects, preserve TLS verification, and keep subscriber credentials out of download requests. Protocol details and limits remain in transport and its tests.

The [feature specification](../../.scratch/qoder-media-tools/spec.md) records configuration and acceptance details. Automated tests mock upstream interactions and consume no subscriber quota; offline protocol fixtures and mocks do not establish live availability for every Qoder service region or subscriber entitlement.
