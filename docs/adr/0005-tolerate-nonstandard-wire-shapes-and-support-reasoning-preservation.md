# Tolerate non-standard wire shapes and support reasoning preservation

## Context

During production use, two wire-level validation strictnesses caused model turns to abort:
1. Some OpenAI-compatible upstream models and API gateways emit tool-call parameter delta chunks with `id: ""` or `id: null` after establishing the identifier in the opening chunk. The transport's SSE parser rejected any chunk with a falsy or non-string `id`, terminating the stream with a malformed response error.
2. DSH context assembly and multi-agent loops can inject prior scratchpad or recall content containing `reasoning` blocks into user-role or non-assistant messages. The static shape validator rejected any non-assistant message carrying a `reasoning` block with an unsupported content error, refusing the turn before any provider communication.

In addition, Qoder models are predominantly reasoning-oriented models (such as DeepSeek-R1, Qwen3.8-Max, and GLM-5.3). The official Qoder client preserves previous reasoning by default (`preserve: true`) and re-transmits it via `reasoning_content` in subsequent assistant messages to maintain reasoning continuity across tool calls and conversational turns, whereas `dsh-provider-qoder` previously discarded all historical reasoning content unconditionally.

## Decision

1. **Tool-Call ID Tolerance**: The SSE wire parser ignores empty strings (`""`) or `null` in `delta.tool_calls[].id` whenever an active tool-call state already holds a non-empty `id`. Stream-level validation continues to require a non-empty ID before a completed tool call is emitted to the runtime.
2. **Reasoning Role Tolerance**: Static message validation no longer restricts `reasoning` blocks to `assistant` messages. Non-assistant `reasoning` blocks are accepted without error and silently skipped during request serialization, preventing injected context or user quotes from failing the turn.
3. **Reasoning Preservation (`preserveThinking`)**: A new configuration option `preserveThinking` (defaulting to `true`, matching the official Qoder client) controls whether historical assistant reasoning is relayed to the Qoder gateway. When enabled, assistant `reasoning` blocks are aggregated and sent as `reasoning_content` on the assistant message. Pure-reasoning assistant messages are preserved with a single whitespace `content` placeholder to ensure valid OpenAI-compatible payloads without dropping model reasoning turns. When explicitly set to `false`, reasoning content is stripped, conserving tokens.
