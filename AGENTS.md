# Repository Guidelines

## Project Scope & Architectural Boundaries

This repository delivers `dsh-provider-qoder`, an extension enabling DeepSeek Harness (DSH) to access Qoder subscription models.

- **Separation of Concerns**: DSH platform integration (`src/dsh/`), settings UI (`src/client/`), and Qoder upstream transport (`src/qoder/`) are strictly decoupled.
- **Centralized Transport**: All upstream Qoder network interactions must be centralized in `QoderTransport`. Never scatter direct `fetch` calls across the adapter layers (see ADR-0003).
- **Ubiquitous Language**: Strictly adhere to the domain terminology defined in `CONTEXT.md` (e.g., Managed Qoder PAT, Job Token, Context Tier, Multimodal Input). Never use synonyms explicitly advised against in the glossary.

## Commands & Verification

Refer to `package.json` for dependencies and available scripts. Key verification workflows:

- `pnpm test`: Run unit tests. Tests mock network interactions by default; **never consume real Qoder quota in automated tests**.
- `pnpm run verify`: Run build, typecheck, and unit tests.
- `pnpm run check`: Full pre-release verification (includes `verify` and a dry-run package packing check).

## Workflow & Safety Guardrails

- **Branching & Releases**: Follow GitHub Flow with `main` as the sole release branch; merge PRs exclusively via **Squash and Merge**. Releases are triggered by semantic `v*` tags on `main` (e.g., `pnpm run release:patch`).
- **Commit Conventions**: Follow Conventional Commits. PRs must explain Qoder upstream behavior, reference relevant ADRs/issues, and include screenshots for UI changes along with compatibility notes.
- **Security Red Lines**: Never commit tokens, secrets, or local credential stores. Maintain lockfile integrity; never weaken TLS verification or introduce unauthorized paid-provider fallbacks.

## Agent Guidelines

- **Domain Documentation**: Single-context architecture. Read `CONTEXT.md` in the root and ADRs in `docs/adr/` before exploring or making architectural changes (see `docs/agents/domain.md`).
- **Issue Tracking**: Local issues and feature specifications are tracked as Markdown files under `.scratch/` (see `docs/agents/issue-tracker.md`).
