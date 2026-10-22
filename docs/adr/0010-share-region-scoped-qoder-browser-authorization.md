# Share region-scoped Qoder browser authorization within a DSH instance

Qoder browser authorization is shared by the DSH instance and stored separately per service region, extending the existing instance-level credential model rather than introducing per-user accounts. Upstream authentication remains owned by Qoder transport (ADR-0003).

Subscribers explicitly select browser authorization or the Managed Qoder PAT; failures never trigger automatic fallback to another account. Removing browser authorization preserves an explicit disconnected state so an existing PAT cannot silently become active. Existing PAT-only installations retain their behavior until the subscriber changes the selection.
