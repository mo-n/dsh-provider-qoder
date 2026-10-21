# Share region-scoped Qoder browser authorization within a DSH instance

Support Qoder's PKCE browser device flow alongside the existing Managed Qoder PAT. One browser authorization and one active login attempt per service region are shared by the DSH instance, following its existing credential-management trust model. This avoids collecting passwords or embedding the Qoder agent SDK (ADR-0001).

DSH owns login-attempt lifecycle and durable `grant` records; Qoder transport owns authorization URLs, polling, identity verification and device-token refresh (ADR-0003). Region-scoped records select PAT, browser authorization, or explicitly disconnected state; absence retains legacy PAT behavior (ADR-0002). There is no automatic fallback between authentication methods. Leaving a region cancels its pending attempt, without deleting its saved authorization.

Refresh runs under the credential store's exclusive read-modify-write lock and checks authorization identity before committing. A rotated credential that cannot be saved remains usable in memory, is reported as unsaved, and is retried on subsequent use. Cancellation, replacement and logout fence late writes. Existing requests retain their captured subscriber identity; subsequent requests resolve the current selection. Logout removes DSH's browser authorization, not the website session or other devices.
