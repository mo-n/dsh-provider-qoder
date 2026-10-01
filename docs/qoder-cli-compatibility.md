# Qoder CLI communication compatibility

The protocol reference for this transport is the supplied `@qoder-ai/qodercli`
1.1.48 distribution, audited on 2026-10-01. This identifies the protocol baseline;
it does not mean Qoder publishes or endorses this provider. The version declared
in Open API headers, COSY authorization and `business.version` comes from one
constant in `wire/cosy.ts`. The declared client version is now `1.1.65`, as
requested; the offline fixtures remain the verified `1.1.48` samples. This change
does not constitute an audit of the 1.1.65 CLI implementation.

## Verified and corrected

| Area | Behavior |
| --- | --- |
| Managed Qoder PAT exchange | Resolve the stable Machine ID before exchange and include `machine_id`. No fabricated UMID token. |
| Qoder job token expiry | Match CLI seconds/milliseconds compatibility and prefer absolute expiry; accept token and identity aliases used by CLI. |
| Subscriber organization | Preserve flat and nested organization IDs and tags. Read missing tags through the organization Open API route with an independent 3-second budget; retain credentials and organization identity if enrichment fails or times out. |
| Subscriber status | Omit UMID headers when no actual UMID is available. Machine ID is not a UMID fingerprint. |
| COSY authorization | Encrypt uid, job token and available organization/privacy context; send the CLI business headers and native platform name. Ordinary COSY requests retain the CLI Machine ID fallback. |
| Model authentication recovery | Refresh once for HTTP 401/403 before SSE starts. Reuse the prepared body and turn identity; do not refresh for duplicate-request code `103`. Never replay a successful HTTP stream. See ADR-0003. |
| Client metadata | Consistent version, native OS, model MachineHostname, CLI system text blocks, China session branding and `start` → `processing` run stages. |
| Machine ID lifecycle | Honor CLI config-directory overrides per region; retain a stable process identity if fallback persistence fails. |

The required PAT exchange and subscriber identity lookup share the authentication
budget (15 seconds by default). Once both succeed, that timer is cleared. Optional
organization-tag enrichment has its own 3-second budget covering reads and retries;
its failure returns the core credentials. Caller cancellation remains shared across
both phases, including last-waiter cancellation for concurrent callers.

## Offline evidence

The supplied bundle embeds an authentication WASM module. Its generated
JavaScript bindings and WASM were extracted and run with synthetic identities,
without starting the CLI entry point or accessing Qoder services. The protocol
fixture in `tests/fixtures/qoder-cli-1.1.48.json` contains only body-encoding vectors,
non-secret headers and the model URL. Automated tests require neither that bundle
nor the extracted WASM.

The independent comparison confirmed model/search body encoding (including UTF-8),
COSY signature concatenation, signature paths without `/algo` or query strings,
and image publication signing the decimal body length. Tests verify actual MD5
signatures instead of relying on extra diagnostic headers absent from the CLI.
The encrypted user-info schema is additionally checked by decrypting a test-only
payload with a deterministic test key.

CLI evidence symbols include `exchangePersonalToken`, `getMachineIdentityRequestFields`,
`fetchOpenApiUserInfo`, `fetchOrganizationTags`, `fetchUserStatus`, `ZzA`,
`regenerateRuntimeFields`, `getUserInfoForAuth`, `Wki`, `Ms`, `z4A` and
`changeBusinessState`.

## Deliberate remaining differences

- There is no native UMID bridge. Both PAT exchange and subscriber-status reads
  omit UMID fields rather than inventing a security fingerprint. CLI itself permits
  omission when its UMID is unavailable.
- An explicit upstream privacy value is preserved. When absent, the existing
  `disagree` policy remains; this provider does not change subscriber consent or
  implement CLI's privacy-policy polling. CLI's `NO_RECORD` → agree behavior is
  deliberately not copied.
- Model endpoints remain region-scoped and fixed. CLI's dynamic endpoint election,
  HTTPDNS and telemetry are not ported; the audit did not establish that their
  absence causes rejection. This preserves ADR-0003's transport scope.
- Model configuration remains based on advertised catalog metadata rather than
  reproducing every CLI configuration field or inventing defaults.
- Search uses the verified `oneSearch` envelope but has no host-provided turn
  identity for CLI's optional `request_set_id`/`X-Session-ID` association.
- Run stages advance when another model request arrives. No final run-completion
  request is fabricated because the current host seam does not expose that event.

These checks establish local compatibility, not server acceptance or immunity
from platform restrictions. No real Qoder quota was consumed during verification.
