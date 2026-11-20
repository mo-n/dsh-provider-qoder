# Expose Qoder image capabilities through DSH tools

We expose Qoder image search and image generation as native DSH tools (`ImageSearch` and `ImageGen`), allowing subscribers to use these capabilities within the provider's existing authorization and service-region configuration. This extends the scope of [ADR-0001](0001-keep-qoder-behind-the-dsh-llm-boundary.md) without adopting the Qoder Agent SDK or duplicating agent loop responsibilities.

## Considered Options

- **Separate image plugin**: Rejected to avoid duplicating authentication and region management across multiple provider integrations.
- **Embed Qoder Agent SDK**: Rejected because its tool and workspace execution overlap DSH's core responsibilities.
- **Direct workspace writes**: Rejected because the host filesystem interface cannot guarantee portable binary writes across arbitrary execution environments; we use DSH durable attachments instead.
- **Return upstream URLs directly**: Rejected because delivery would depend on volatile upstream URLs rather than persistent DSH attachments.

## Delivery Semantics and Safety Guardrails

- **Ownership boundary**. Qoder transport handles upstream authentication, signing, and generation, then returns the validated image bytes. DSH saves those bytes as a durable attachment and maps its path for reading in the execution environment.
- **No speculative regeneration**: To protect subscriber quota, uncertain generation failures (timeouts, network drops) are never automatically replayed. Credential recovery is restricted to an explicit HTTP 401 before resubmitting the request ID.
- **Secure downloads**. The transport enforces resource limits, validates download destinations and redirects, preserves TLS verification, and keeps subscriber credentials out of download requests.
