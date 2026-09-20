# Accept a Qoder stream that ends without the DONE sentinel

## Context

The SSE parser treated the `[DONE]` sentinel as the only proof that a model stream had ended, and raised a retryable `TRANSPORT` error whenever the response body closed without it. The sentinel is the shape DSH's OpenAI-compatible expectations and the existing fixtures assume, and the strictness was deliberate: retrying a half-delivered turn was preferred over silently handing an incomplete response to the agent loop.

Live traffic on the Qoder Sonus route shows that this assumption does not hold everywhere. A tool-calling turn arrives as text deltas, a complete `todo_write` tool call, and a terminal frame carrying a finish reason, and then the response body simply closes — no `data: [DONE]` frame and no envelope whose body is `[DONE]`. Every attempt, including the tool-free session-title request, ended the same way. Because the parser threw before its finalization phase, the fully assembled tool call was discarded, and DSH's retry policy replayed the same request five times with the same result. The route also reports a tool-calling turn with the legacy OpenAI finish reason `function_call` rather than `tool_calls`, so the terminal frame additionally failed the finish-reason whitelist and aborted the stream even earlier.

## Decision

1. **Legacy finish-reason alias**: `function_call` is accepted as equivalent to `tool_calls` and normalizes to the DSH `tool-calls` finish kind. Unknown reasons are still rejected as malformed responses, so genuine protocol drift remains detectable.
2. **Terminal finish reason replaces the sentinel**: a clean end of body is a successful stream end when an explicit terminal finish reason was observed and nothing streamed after it. A content, reasoning, or tool-call delta arriving after a finish reason means the turn kept going, so that reason was not terminal and the sentinel is required again; the `TRANSPORT` truncation error is then raised exactly as before. A body that ends with no finish reason at all keeps failing the same way.

A stream that fails to terminate is therefore judged by evidence that the provider declared completion, not by a transport-level marker that not every Qoder route emits.

## Consequences

Truncation detection is preserved where it matters: an interrupted stream that never received a finish reason still fails as retryable `TRANSPORT`, and so does a stream whose frames kept streaming after a finish reason was declared but which then closed without the sentinel. Tool-call integrity is still enforced during finalization, so an incomplete tool call, an unidentifiable call, or malformed JSON arguments remains a malformed response.

The parser does not prove that the terminal finish reason was literally the last frame of the body: a trailing usage-only or otherwise control-only frame is tolerated, which is how the observed route ends. What makes a missing sentinel safe to accept is narrower and verifiable — every frame that streams data after a declared terminal reason re-arms the sentinel requirement, so content that arrives past a finish reason can never be handed to the agent loop as a complete turn.

The remaining exposure is a route that omits both the sentinel and the finish reason: such a turn still fails as `TRANSPORT`, and the session-title request will keep falling back to the truncated first prompt. This behavior is unverified against the Sonus route's tool-free requests, because no request payload was captured; the assumption is recorded here rather than encoded as a further relaxation. Accepting any clean end of body — the common OpenAI-compatible client behavior — was rejected because it would silently accept a lost-frame turn whose reasoning and text were cut mid-flight.

Two further wire behaviors are deliberately not covered, recorded here so this decision is not read as a broader guarantee:

1. A turn that declares `function_call` or `tool_calls` without ever streaming a tool-call delta is relayed with the `tool-calls` finish kind while no tool-call block is delivered. The reason is reported as received rather than rewritten to `stop`; DSH's agent loop tolerates the mismatch (it counts delivered blocks, not the reason), but the session-title provider treats a `tool-calls` finish as an error. No live capture has shown this shape.
2. Only the legacy finish *reason* is accepted. The legacy payload shape `delta.function_call` is not parsed, so a route that streamed tool calls that way would lose them. Live capture of the Sonus route shows modern `delta.tool_calls` deltas, which keeps this a defensive gap rather than an observed defect.

Nothing in the Qoder wire contract is claimed beyond what was observed: the sentinel remains valid and is still honored when present, and the envelope-body form continues to be recognized.
