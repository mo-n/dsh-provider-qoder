# Identify a Qoder request by its turn, not by its step

A DSH turn issues one model request per reasoning step, so a single subscriber prompt becomes dozens of consecutive Qoder requests. Qoder's Credits panel lists one row per agent run and totals that run's requests, while the transport reported a fresh `business.id` on every request, so one subscriber prompt appeared as dozens of disjoint sub-minute entries instead of one record covering the turn.

The transport now reports an agent run the way the official client does, which is what makes the service aggregate a turn:

- `business.id` and `business.begin_at` identify one agent run and are reused by every request of that turn. This is the aggregation key: the official CLI creates one `business.id` per agent run (`id: L || randomUUID()`), so a stable value here is what turns a turn's requests into one consumption record.
- `request_set_id` carries the same turn identity, matching the official client's per-run `AgentLifecycle.requestSetId`.
- `chat_record_id` equals that request's own `request_id`, and `request_id` is a fresh UUID per request, matching the official client exactly.
- `session_id` keeps identifying the conversation and is unchanged.

The turn boundary is derived in `qoder/transport/wire/turn-identity.ts`, because the adapter sees no turn number. A turn is identified as the multiset of user-role messages it has accounted for, not by the position or the text of one anchor message. Three properties of the request stream make position and text unreliable:

- The harness appends its own context (workspace instructions, runtime context, memory recall, model-change notices, background notifications, checkpoint markers, delegated agents' messages) while the turn runs.
- History can be trimmed, which moves any message's position and can drop the anchor itself.
- The translation layer materializes a turn's own tool-result images as a user-role message, and published image URLs are re-signed as their cache entries expire.

An unaccounted subscriber message opens the next turn; everything else continues the open record. Host-appended context and transport-synthesized markers are recognized as such, and the two host notifications whose wording a subscriber may legitimately reuse (`Agent <id> sent a message:`, `Background subagent <id> finished`) are matched on the host's own template — sender identity plus fixed phrase — rather than on a bare prefix that would swallow real prompts. Occurrences a request no longer carries are forgotten, and image URLs are excluded from a message's fingerprint so re-signing cannot make a turn's own prompt look like new input.

Known limit: because the host's message ids are not part of the wire shape, text identifies a message. A subscriber who sends the same words twice with the first copy already gone from history — compaction replaced that span — shares the open record instead of opening a new one. Carrying `Message.id` through translation is the fix, and it needs the adapter to receive it.

The host routes its own auxiliary calls — session title and compaction summary — through this provider under the same session identity with a message list of their own, and marks them through `GenerateOptions.purpose`. They report a run of their own for exactly that request: they never open a turn, never claim the record the subscriber's next prompt would open, and never displace the run that is still in flight.

Three candidate keys were tested against the live panel before this one. A stable `session_id`, a turn-stable `chat_record_id`, and a turn-stable `request_set_id` each left the panel showing one row per request; only the agent-run `business.id` merged them.

Two consequences remain. A process that restarts mid-turn cannot recover the open run, so the turn that was running is split into two. And the tracker is bounded per session: conversations untouched for an hour are evicted first, because an idle conversation cannot still be running a turn, and only when every recorded conversation is more recent than that does the session ceiling drop the coldest — which can split the turn it was running. The session ceiling is therefore far above the number of conversations a subscriber works on at once.
