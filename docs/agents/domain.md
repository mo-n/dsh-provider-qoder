# Domain Documentation

Follow these rules when reading and updating domain documentation in this repository.

## Required Reading

Before exploring code or proposing architectural changes, read:
- `CONTEXT.md` at the repository root
- Relevant ADRs in `docs/adr/`

## Repository Layout

This repository uses a single-context layout:

```text
/
├── CONTEXT.md
├── docs/adr/
└── src/
```

## Ubiquitous Language

- Always use the terminology defined in `CONTEXT.md` when naming domain concepts (such as issue titles, refactoring plans, test names, and types).
- Never use synonyms explicitly advised against in the glossary (`_Avoid_` list).
- If a domain concept is missing from `CONTEXT.md`, record the vocabulary gap for domain modeling rather than inventing ad-hoc synonyms.

## ADR Conflicts

If a proposed change conflicts with an existing ADR, explicitly state the conflict rather than silently overriding it:

> Conflicts with ADR-0003 (Centralize Qoder Upstream Access in Qoder Transport), but worth reopening because...
