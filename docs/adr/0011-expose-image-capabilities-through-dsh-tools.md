# Expose Qoder image capabilities through DSH tools

We expose `ImageSearch` and `ImageGen` through DSH's tool registry while Qoder transport owns their upstream authentication, signing, requests, and generated-image downloads. This extends the original authentication/model-only scope in ADR-0001 without embedding Qoder's agent loop or bypassing DSH tool policy. Image search and image generation have independent, live boolean settings; the initiator-aware web search modes in ADR-0006 remain unchanged.

Generated images are delivered through DSH's durable attachment storage, preserving the original bytes and exposing an execution-world read path where the filesystem provider supports one. The published DSH filesystem interface has no binary write operation, so the provider must not use host filesystem writes to simulate an arbitrary workspace destination. The existing `read_image` tool can inspect the saved image; generation does not require the calling language model to support image input.

Generation submissions are not replayed after uncertain failures. Once Qoder has created an image, download or storage failures report delivery failure rather than suggesting another generation. All automated tests mock upstream requests and consume no subscriber quota.
