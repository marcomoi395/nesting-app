# Nesting Export Mode File Structures

## Summary

- Sparrow exports native files to `output/` dynamically depending on mode.
- In `barriers` or `fixed` mode, Sparrow creates subdirectories per solver iteration, like `output/final_TEXT 11 2/`, which contain `summary.json` and per-strip JSON/SVG.
- In `unlimited` mode, Sparrow outputs continuous root files directly, like `output/final_TEXT 11 2.json` and `.svg`.
- The native integration handles these files in `main/ipc/sparrow.js`.

## Details

### Lesson

Electron IPC polls need to match exact export filename layouts.
When parsing continuous output from `unlimited` mode, the exact expected filename must match the generated output.
The Sparrow CLI writes `payload.name` inside the run artifacts.
Always ensure `payload.name` is fully sanitized identical to the folder's `safeName` before submitting payload via IPC, otherwise `collectContinuousFinalArtifacts` will look for `final_TEXT-11-2.json` but Sparrow output `final_TEXT 11 2.json`, resulting in an empty / non-existent summary that triggers a `preview` fallback state.

### Why

The fallback preview logic sets `is_preview: true`, which disables the final `Export DXF` functionality.

### Apply By

- When modifying nesting mode IPC integrations, check `main/ipc/sparrow.js` poll and cleanup methods for safeName usage.
- Ensure the name string is sanitized identically in both payload JSON and paths.

## Evidence

- `agent-derived`: Bug analysis during export DXF unlimited mode issue. `main/ipc/sparrow.js` relies on hardcoded path lookup for continuous mode artifacts. `run-sparrow` IPC modified to sync `payload.name` to `safeName`.

## Use When

- Developing, modifying, or debugging Sparrow integration layers in IPC (`main/ipc/sparrow.js` or `export-dxf.js`).
- Adding new nesting solver export formats.

## Do Not Use When

- Working on frontend components without IPC implications.

## Last Updated

- 2026-07-04
