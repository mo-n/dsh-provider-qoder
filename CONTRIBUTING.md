# Contributing to dsh-provider-qoder

Thank you for your interest in contributing to `dsh-provider-qoder`! This guide explains our branch model, development workflow, and coding conventions.

---

## 1. Branching Workflow (GitHub Flow)

We follow the standard **GitHub Flow** model:
- `main` is the sole evergreen production branch. It is always releasable and protected.
- All developments (features, bug fixes, refactoring, docs) originate from `main` via dedicated work branches.
- Contributions merge back into `main` exclusively through Pull Requests after automated CI checks pass.

### Branch Naming Conventions

Always use the slash-delimited `<type>/<short-desc>` format:

| Prefix | Description | Example |
| :--- | :--- | :--- |
| `feat/` | New functionality or provider feature | `feat/custom-model-pricing` |
| `fix/` | Bug fixes and protocol edge cases | `fix/sse-done-sentinel` |
| `refactor/` | Code structure improvements | `refactor/transport-session` |
| `docs/` | Documentation improvements | `docs/contributing-guide` |
| `test/` | Adding or refactoring tests | `test/image-publication` |
| `chore/` | Toolchain, build, or peer dependencies | `chore/update-pnpm` |

---

## 2. Getting Started & Development

1. **Fork and Clone**:
   ```bash
   git clone https://github.com/<your-username>/dsh-provider-qoder.git
   cd dsh-provider-qoder
   ```

2. **Install Dependencies**:
   ```bash
   pnpm install --frozen-lockfile
   ```

3. **Create a Work Branch**:
   ```bash
   git checkout -b feat/<your-feature-name> main
   ```

4. **Verify Locally Before Submitting**:
   Make sure all tests, builds, and type checks pass:
   ```bash
   pnpm run check
   ```

---

## 3. Pull Request Guidelines

- **Target Branch**: Always open PRs against `main`.
- **PR Title & Commits**: Use [Conventional Commits](https://www.conventionalcommits.org/) (e.g., `feat(client): ...`, `fix(transport): ...`).
- **Squash and Merge**: PRs are merged via **Squash and Merge**. The PR title will become the squashed commit message on `main`. Keep the title descriptive and standard.
- **Verification**: Complete the PR template checklist. Ensure all automated GitHub Actions checks pass (`compatibility.yml`).
- **Clean Up**: Head branches should be deleted after the PR is merged.

---

## 4. Release Process (Maintainers)

Releases are completely automated via GitHub Actions on `v*` tag pushes:

1. On `main`, run:
   ```bash
   pnpm run release:patch   # for backward-compatible bug fixes
   # or
   pnpm run release:minor   # for new backwards-compatible features
   # or
   pnpm run release:major   # for breaking changes
   ```
2. The release script runs full validation (`pnpm run check`), increments version in `package.json`, generates a `chore(release): vx.y.z` commit and annotated tag, and pushes to `origin`.
3. The `.github/workflows/publish.yml` workflow automatically publishes the package to npm with provenance and creates a GitHub Release.
