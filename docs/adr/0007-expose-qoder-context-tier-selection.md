# Expose Qoder context tier selection to the subscriber

## Context

A Qoder model advertises its input capacity as a `context_config` map of tiers, each carrying a `token_count` and at most one of them marked `is_default`. DSH, however, models capacity as a single adapter-owned `contextWindow` (`LlmModelContext`), which drives the compaction threshold and the conversation context meter; `GenerateOptions` carries no capacity field at all.

The transport originally resolved that single value from the provider's default tier and recorded the largest tier only as local `maxContextWindow` metadata, which was never reported to DSH or used in a request. Discovery merge additionally capped a stored budget at the provider default. A subscriber therefore could not select a tier larger than the default one: a model advertising 200K by default and 1M as its largest tier stayed at 200K both in DSH and in the request, even though the request had always echoed the whole `context_config` back to the gateway.

## Decision

The subscriber selects one context tier per enabled model in the Qoder credential card. The selection is stored on the catalog entry as `contextTier`, the provider-owned tier key, and drives two things together:

1. The capacity reported to DSH, derived by `effectiveContextWindow`, so the compaction threshold and the context meter follow the selected tier.
2. The tier the model request asks for, by moving the `is_default` marker onto the selected tier and setting it to `false` on its siblings in the echoed `context_config`.

A selection outranks the provider default and may widen the budget beyond it, which is the point of the feature. Without a selection the previous rules are unchanged: the default tier decides the capacity, and a rediscovered catalog may only narrow a stored budget. A selection is dropped as soon as the provider stops advertising that tier, falling back to the default budget rather than carrying a stale key.

Ambiguous provider defaults — zero or multiple `is_default` markers — still send no `context_config` on their own, because an ambiguous catalog must not implicitly pick a tier. An explicit selection resolves that ambiguity and is therefore sent.

## Consequences

The assumption that the gateway honours the `is_default` marker when choosing a tier is inferred from the wire shape, not verified against a live request. If it does not hold, selecting a tier larger than the provider default raises the DSH budget without raising the served capacity, and the turn fails upstream with a context-window error instead of compacting. Selecting a tier is therefore opt-in per model, and the previous default behaviour remains the fallback when nothing is selected.

DSH's one-capacity-per-model shape is preserved: the tier is resolved by the adapter, not by a new provider-facing protocol. A runtime tier switch would require a change to the DSH LLM seam and is out of scope.
