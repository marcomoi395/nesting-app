# Nesting Export Mode File Structures

## Summary

- Sparrow exports native files to `output/` dynamically depending on mode.
- In `barriers` / `fixed` / `max` runs, Sparrow can emit only sparse preview checkpoints during the run, then write final per-strip files later.
- In `unlimited` mode, Sparrow writes continuous root preview files directly, so the UI receives more frequent preview updates.
- The native integration handles these files in `main/ipc/sparrow.js`.

## Details

### Lesson

Electron IPC polls need to match exact export filename layouts.
When parsing continuous output from `unlimited` mode, the exact expected filename must match the generated output.
The Sparrow CLI writes `payload.name` inside the run artifacts.
Always ensure `payload.name` is fully sanitized identical to the folder's `safeName` before submitting payload via IPC, otherwise `collectContinuousFinalArtifacts` will look for `final_TEXT-11-2.json` but Sparrow output `final_TEXT 11 2.json`, resulting in an empty / non-existent summary that triggers a `preview` fallback state.

### Lesson

Live preview dedupe must compare exact SVG content, not a sampled hash.
We observed adjacent solver frames in `output/sols_TEXT 11 2/*.svg` that differed byte-for-byte but collided under the old sampled hash, which made the UI look frozen even when new frames existed.

### Why

The fallback preview logic sets `is_preview: true`, which disables the final `Export DXF` functionality.
The sampled hash collision hid real frame changes, so the renderer skipped updates it should have shown.

### Apply By

- When modifying nesting mode IPC integrations, check `main/ipc/sparrow.js` poll and cleanup methods for safeName usage.
- Ensure the name string is sanitized identically in both payload JSON and paths.
- When changing live preview rendering in `renderer/views/canvas-view.js`, keep exact SVG equality for same-sheet dedupe.

## Evidence

- `agent-derived`: Bug analysis during export DXF unlimited mode issue. `main/ipc/sparrow.js` relies on hardcoded path lookup for continuous mode artifacts. `run-sparrow` IPC modified to sync `payload.name` to `safeName`.
- `test-verified`: `scripts/check-sparrow-running-preview.js`, `scripts/check-sparrow-poll.js`, and `scripts/check-svg-preview-signature.js` passed after fix.
- `code-verified`: `renderer/views/canvas-view.js` now uses exact SVG string equality for same-sheet dedupe.

## Use When

- Developing, modifying, or debugging Sparrow integration layers in IPC (`main/ipc/sparrow.js` or `export-dxf.js`).
- Debugging live preview cadence or missing frame updates in the nesting canvas.
- Adding new nesting solver export formats.

## Do Not Use When

- Working on frontend components without IPC implications.
- Changing solver quality logic without touching artifact layout or live preview flow.

## Last Updated

- 2026-07-05
