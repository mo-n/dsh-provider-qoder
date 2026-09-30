# Repository Guidelines

## Project Structure & Module Organization

The deliverable is the root ESM package, `dsh-provider-qoder`: a DSH extension that lets users access their Qoder subscription.

## Architecture Direction

Separate DSH registration, configuration, and credentials from Qoder transport logic. Treat the Pi provider as protocol evidence, not the desired public API; adapt it to the DSH conventions demonstrated by the Codex plugin. Never copy secrets, cached credentials, or generated output.

## Build, Test, and Development Commands

The root has no npm scripts and depends on DSH workspace peers; validate it from its host DSH workspace. These reference checks help while porting:

```sh
cd pi-provider-qoder && npm ci
npm run check && npm run lint && npm test && npm run build

cd dsh-codex-subscription && pnpm install --frozen-lockfile
pnpm run check
```

The subscription `check` command runs tests, builds, and verifies its package tarball.

## Coding Style & Naming Conventions

Use ESM imports, two spaces, single quotes, and no semicolons. Use `camelCase` for values, `PascalCase` for types/classes, and kebab-case script names. Isolate translation, SSE parsing, credentials, and DSH registration behind testable boundaries.

## Testing Guidelines

Add root tests as `*.test.ts`, colocated with source or under `tests/`. Cover authentication, translation, SSE/tool-call streaming, models, quota, settings, and packaging. Mock network responses by default; do not consume Qoder quota unless explicitly required.

## Branching & Release Workflow

This repository strictly follows **GitHub Flow** with `main` as the single production and release branch.

- **Branch Naming**: All work branches must follow the hierarchical pattern `<type>/<short-desc>`, where `<type>` aligns with Conventional Commits:
  - `feat/<feature-name>`: New capabilities or provider features
  - `fix/<issue-name>`: Bug fixes and regressions
  - `refactor/<target>`: Internal structure improvements without functional change
  - `docs/<topic>`: Documentation updates
  - `test/<scope>`: Test additions or test framework updates
  - `chore/<target>`: Tooling, dependency, or configuration updates
- **PR & Merge Policy**: All contributions merge into `main` via **Squash and Merge**. Ensure PR titles use Conventional Commits since the squashed commit title on `main` will inherit it. Delete head branches immediately upon merge.
- **Releases**: Releases are tag-driven and triggered by `v*` tags on `main`. Verify with `pnpm run check`, bump version and tag with `pnpm version <version> -m "chore(release): %s"`, and push with tags (`git push && git push --tags`) to trigger `.github/workflows/publish.yml`.

## Commit & Pull Request Guidelines

Reference histories use Conventional Commits (`feat:`, `fix:`, `test:`, `docs:`, `ci:`, `chore:`). Keep commits scoped and imperative. PRs must explain implemented Qoder behavior, cite reference evidence, link issues, and list validation commands. Include screenshots for UI changes and flag authentication or compatibility impacts.

## Security & Configuration

Never commit OAuth tokens, API keys, account identifiers, callbacks, or local credential stores. Preserve lockfiles and avoid weakening TLS or silently introducing paid-provider fallbacks.

## Agent skills

### Issue tracker

议题和规格以本地 Markdown 文件形式存放在 `.scratch/`。详见 `docs/agents/issue-tracker.md`。

### Domain docs

领域文档采用单上下文布局。详见 `docs/agents/domain.md`。
