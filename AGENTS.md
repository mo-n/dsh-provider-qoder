# Repository Guidelines

## Project Structure & Module Organization

The deliverable is the root ESM package, `dsh-provider-qoder`: a DSH extension that lets users access their Qoder subscription.

- `src/dsh/` owns DSH registration, configuration, credentials, settings RPC, and provider integration.
- `src/qoder/` owns Qoder models, account data, and transport. `src/qoder/transport/wire/` handles protocol conversion and streaming.
- `src/client/` contains the settings and context-tier UI. `tests/` contains root package tests.

Keep production behavior and tests in the root package. Do not copy secrets, cached credentials, or generated output from reference implementations.

## Architecture Direction

Separate DSH registration, configuration, and credentials from Qoder transport logic. DSH owns the agent loop and tools; Qoder transport owns provider authentication and upstream communication.

## Build, Test, and Development Commands

The root package has its own scripts and pinned development dependencies. From the repository root, run:

```sh
pnpm install --frozen-lockfile
pnpm run check
```

`check` builds, typechecks, runs tests, and verifies the package contents with `pnpm pack --dry-run`. Use `pnpm run dev` for a watch build.

## Coding Style & Naming Conventions

Use ESM imports, two spaces, single quotes, and no semicolons. Use `camelCase` for values, `PascalCase` for types/classes, and kebab-case script names. Isolate translation, SSE parsing, credentials, and DSH registration behind testable boundaries.

## Testing Guidelines

Add root tests as `*.test.ts`, colocated with source or under `tests/`. Cover authentication, translation, SSE/tool-call streaming, models, quota, settings, and packaging. Mock network responses by default; do not consume Qoder quota unless explicitly required.

## Commit & Pull Request Guidelines

Reference histories use Conventional Commits (`feat:`, `fix:`, `test:`, `docs:`, `ci:`, `chore:`). Keep commits scoped and imperative. PRs must explain implemented Qoder behavior, cite reference evidence, link issues, and list validation commands. Include screenshots for UI changes and flag authentication or compatibility impacts.

## Security & Configuration

Never commit OAuth tokens, API keys, account identifiers, callbacks, or local credential stores. Preserve lockfiles and avoid weakening TLS or silently introducing paid-provider fallbacks.

## Agent skills

### Issue tracker

议题和规格以本地 Markdown 文件形式存放在 `.scratch/`。详见 `docs/agents/issue-tracker.md`。

### Domain docs

领域文档采用单上下文布局。详见 `docs/agents/domain.md`。
