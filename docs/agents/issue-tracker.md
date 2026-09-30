# Issue Tracker: Local Markdown

Issues and feature specifications in this repository are tracked as Markdown files under `.scratch/`.

## Structure & Conventions

- **Directory per feature**: `.scratch/<feature-slug>/`
- **Specification**: `.scratch/<feature-slug>/spec.md`
- **Tasks**: `.scratch/<feature-slug>/issues/<NN>-<slug>.md` (numbered from `01`, one task per file)
- **Discussion**: Append notes and review comments under a `## Comments` section at the end of the file.

## Task Tracking Metadata

When managing structured subtasks or tracking progress:
- **Status**: Mark `Status: claimed` before starting; mark `Status: resolved` under an `## Answer` section upon completion.
- **Dependencies**: Declare blockers at the top with `Blocked by: NN, NN`.
- **Map file (optional)**: For larger efforts, maintain `.scratch/<effort>/map.md` with current decisions and scope notes.
