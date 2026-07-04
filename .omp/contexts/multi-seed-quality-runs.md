# Multi-seed Sparrow Quality-Run Selection

## Summary

- `Quality runs` is visible in Algorithm settings and defaults to `1`, so normal behavior stays single-run until user opts in.
- Multi-seed mode runs Sparrow sequentially with deterministic seeds derived from `rngSeed`: `[base, base + 101, base + 1009, base + 10007, base + 100003]`, capped to 5 runs.
- After best full-run seed is chosen, `Quality runs > 1` also triggers bounded tail local search on exact placed items from final sheet only: `last-only`.
- Tail replacement can keep or reduce strip count on that final-sheet rerun, never increase it; better candidate selection prefers fewer strips, then denser last sheet, then stronger tail densities, then smaller last-strip width, then total item count.
- Tail subset runs preserve original item ids, so export and canvas code stay unchanged when refined strips replace tail sheets.

## Details

- Completed strip summaries now carry `placed_item_counts` and `placed_item_ids` from final strip JSON in `main/ipc/sparrow.js`; live preview strips still omit them.
- Tail helper lives in `renderer/utils/tail-refinement.js` and exports `NestTailRefinement` with candidate generation, payload slicing, merge, scoring, and comparison helpers.
- Candidate search is now bounded to final sheet only (`last-only`) and `Math.max(3, qualityRunCount(settings))` seeds, still capped by existing `qualityRunSeeds` length of 5.
- Tail runs reuse existing renderer orchestration in `renderer/services/nesting-service.js` with canonical `runSparrow`, `pollSparrow`, `stopSparrow`, and `waitForSparrowCompletion` flow.
- Tail run options intentionally force `align: 'top-left'` and longer `globalTime` floor (`120`–`300`) while keeping existing early-stop setting.
- Tail refinement failure is non-fatal once full solve succeeded: failed candidates log warnings, and final result falls back to best full-run summary.
- Stop button still aborts whole sequence through existing `stopSparrow()` behavior, including tail attempts.
- `main/utils/compact-last-strip.js` still compacts every completed Sparrow run, including tail subset runs, before renderer receives replacement strips.

## Evidence

- `user-stated`: approved plan first required bounded `last-only` / `last-2` / `last-3` tail refinement, then narrowed behavior to `last-only` only, with no new setting and no IPC/export-retention changes.
- `code-verified`: `main/ipc/sparrow.js` adds `readPlacedItemCounts()` and attaches `placed_item_counts` / `placed_item_ids` to completed strip summaries using final `json_path`.
- `code-verified`: `renderer/index.html` loads `utils/tail-refinement.js` after `utils/nest-result-scoring.js` and before `services/nesting-service.js`.
- `code-verified`: `renderer/utils/tail-refinement.js` adds pure helpers for tail candidate generation, subset payloads, merged summaries, and tail-score ordering.
- `code-verified`: `renderer/services/nesting-service.js` adds `runTailRefinement()` after best full-run seed selection and leaves single-run path unchanged when `Quality runs = 1`.
- `code-verified`: `renderer/services/export-service.js`, `main/utils/temp-retention.js`, `main/utils/compact-last-strip.js`, and `main/ipc/export-dxf.js` were intentionally left unchanged; compatibility depends on preserved original item ids and reused artifact paths.
- `test-verified`: `node scripts/check-tail-refinement.js` printed `ok`.
- `test-verified`: `node scripts/check-nest-result-scoring.js` printed `ok`.
- `test-verified`: `node scripts/check-compact-last-strip.js` printed `ok`.
- `test-verified`: `node scripts/check-solver-polygon-export.js` printed `ok`.

## Use When

- Changing Sparrow seed selection, quality-run orchestration, or stop behavior.
- Adjusting how multi-sheet/tail quality is scored or how final-sheet tail refinement is generated.
- Investigating why export or preview should show chosen best run after multi-seed execution or final-sheet tail refinement.
- Adding tests around final-sheet replacement merging, fixed-width density handling, or tail payload slicing.

## Do Not Use When

- Working on unrelated DXF import, contour detection, or export formatting tasks.
- Changing generic UI settings behavior with no nesting-run impact.

## Last Updated

- 2026-07-04
