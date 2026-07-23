# Contexts Index

Use this index to decide which `.omp/contexts/` files to read before starting work. Load only files relevant to current task.

## Context Files

| File | Topic | Use When | Last Updated |
|---|---|---|---|
| [`dxf-export-behavior.md`](dxf-export-behavior.md) | DXF export writer, block mode, and export-time settings precedence | Modifying `export-dxf.js`, DXF export settings, block-vs-flat output, or stale export setting bugs | 2026-07-05 |
| [`multi-seed-quality-runs.md`](multi-seed-quality-runs.md) | Multi-seed Sparrow quality-run selection and tail refinement | Working on nesting quality-run behavior, final-sheet tail refinement, scoring, seed selection, or final result/export wiring | 2026-07-23 |
| [`nesting-export-layout.md`](nesting-export-layout.md) | Nesting Export Mode File Structures | Developing or debugging Sparrow integration layers, modes, or export file path resolutions in IPC | 2026-07-05 |

## Maintenance Rules

- Add one row for every file in `.omp/contexts/` except `CONTEXTS_INDEX.md`.
- Keep `Use When` specific enough to route future context loading.
- Update `Last Updated` when corresponding context file changes.
- Remove rows only when corresponding context file is deleted.
