# DXF Export Behavior

## Summary

- DXF export in `main/ipc/export-dxf.js` now uses `@tarikjabiri/dxf` instead of handwritten DXF text, and defaults to `AC1021` output. 
- Export supports two modes controlled by setting `useBlocks`: `true` writes one sketch block per part plus `INSERT` placements; `false` flattens transformed geometry directly into model space.
- Export-time settings must prefer explicit current UI settings passed from `renderer/services/export-service.js` over stale settings stored in prior `state.nestInputPath` placement JSON.
- Sketch block names are derived from `PART_<item_id>_<label>` and sanitized through `sanitizeDxfName()`.

## Details

### Lesson

DXF export settings can drift after a solver run if export re-reads only the placement JSON created at run time.

### Why

The renderer stores run inputs in `state.nestInputPath`, and earlier export logic read only `inputData.settings` from that file. If the user changed `useBlocks` in Settings after pressing Run but before pressing Export DXF, export still used the old mode.

### Apply By

- When adding any future DXF export toggle, pass current settings through `window.electronAPI.exportSheetsDXF(...)` and merge them after `inputPath` settings inside `main/ipc/export-dxf.js`.
- Treat `inputPath` settings as run-time defaults only; treat explicit IPC `settings` as authoritative export-time overrides.

### Export structure

- `buildDXF(...)` in `main/ipc/export-dxf.js` creates layers, sets extents, then:
  - if `exportSettings.useBlocks !== false`, creates one DXF block per sketch from `sketchPlacements`, writes local entities into each block, and places them with `dxf.modelSpace.addInsert(...)` using placement translation + rotation.
  - otherwise emits flat transformed entities from `sheetEntities` directly into model space.
- Engraving label strokes are still emitted directly into model space after the main sketch geometry path.
- Fallback polygon export for shapes with no renderable entities must stay local in block mode and transformed only in flat mode.

## Evidence

- `code-verified`: `main/ipc/export-dxf.js:18-43` merges explicit IPC `settings` after loading `inputPath` settings.
- `code-verified`: `main/ipc/export-dxf.js:960-1002` branches between block export and flat export based on `exportSettings.useBlocks`.
- `code-verified`: `main/ipc/export-dxf.js:1041-1127` builds both `sheetEntities` and `sketchPlacements`, and records `block_name` in debug rows.
- `code-verified`: `main/ipc/export-dxf.js:446-447` derives block labels from source filenames before sanitization.
- `code-verified`: `shared/settings.js:65-69` defines `useBlocks: true` as default; `renderer/index.html:228-241` exposes the toggle in Settings.
- `code-verified`: `renderer/services/export-service.js:240-247` sends current settings in the export IPC payload; `renderer/renderer.js:288-292` wires `currentNestingSettings` into export service.

## Use When

- Modifying DXF export structure or settings in `main/ipc/export-dxf.js`.
- Adding new export-time toggles in renderer settings or export modal flow.
- Debugging cases where DXF export does not match current Settings dialog state.
- Updating focused DXF regression scripts.

## Do Not Use When

- Working on Sparrow polling / preview artifact layout unrelated to DXF export settings.
- Changing generic renderer settings that do not affect DXF export payloads.

## Last Updated

- 2026-07-05
