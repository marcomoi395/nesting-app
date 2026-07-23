# Multi-seed Sparrow Quality-Run Selection

## Summary

- `Quality runs` is visible in Algorithm settings and defaults to `1`, so normal behavior stays single-run until user opts in. `Tail runs` controls tail refinement seed count per candidate (defaults to `1`, range 1-5).
- Multi-seed mode runs Sparrow sequentially with deterministic seeds derived from `rngSeed`: `[base, base + 101, base + 1009, base + 10007, base + 100003]`, capped to 5 runs.
- Multi-seed mode runs each quality seed sequentially, completes full Sparrow solve plus per-seed `last-only` tail refinement (seed count controlled by `Tail runs` setting), then compares final summaries using unified scoring.
- Final quality-run selection uses `renderer/utils/nest-result-scoring.js` with priority: `totalItemCount` (no dropped parts), `stripCount` (fewer sheets), `lastStripWidth` (smaller tail = more reusable), `bodyScore` (sum of squared body densities for greedy packing), `lastDensity` (tie-breaker).
- Tail subset runs preserve original item ids, so export and canvas code stay unchanged when refined strips replace tail sheets.

## Details

- Completed strip summaries now carry `placed_item_counts` and `placed_item_ids` from final strip JSON in `main/ipc/sparrow.js`; live preview strips still omit them.
- Tail helper lives in `renderer/utils/tail-refinement.js` and exports `NestTailRefinement` with candidate generation, payload slicing, merge, scoring, and comparison helpers.
- Candidate search is now bounded to final sheet only (`last-only`) and uses `Tail runs` setting (defaults to 1, range 1-5) to control seed count per candidate, allowing users to trade tail optimization quality for run time.
- Each seed completes both full solve and tail refinement before comparison; `renderer/utils/nest-result-scoring.js` scores the final merged summary (body + tail) with unified priority order.
- `renderer/utils/tail-refinement.js` remains per-seed local search for the final sheet only; it uses separate `scoreTailRefinementSummary()` and `isTailRefinementBetter()` to optimize within one seed's tail candidates, then returns the best refined summary for that seed.
- Tail refinement failure is non-fatal once full solve succeeded: failed candidates log warnings, and final result falls back to best full-run summary.
- Stop button still aborts whole sequence through existing `stopSparrow()` behavior, including tail attempts.
- `main/utils/compact-last-strip.js` still compacts every completed Sparrow run, including tail subset runs, before renderer receives replacement strips.

## Evidence

- `user-stated`: approved plan first required bounded `last-only` / `last-2` / `last-3` tail refinement, then narrowed behavior to `last-only` only, with no new setting and no IPC/export-retention changes.
- `code-verified`: `main/ipc/sparrow.js` adds `readPlacedItemCounts()` and attaches `placed_item_counts` / `placed_item_ids` to completed strip summaries using final `json_path`.
- `code-verified`: `renderer/index.html` loads `utils/tail-refinement.js` after `utils/nest-result-scoring.js` and before `services/nesting-service.js`.
- `code-verified`: `renderer/utils/tail-refinement.js` adds pure helpers for tail candidate generation, subset payloads, merged summaries, and tail-score ordering.
- `code-verified`: `renderer/services/nesting-service.js` calls `runTailRefinement()` inside `runQualitySeedSequence()` per-seed loop after each full solve, then scores final merged summary; multi-run branch no longer calls tail refinement separately.
- `code-verified`: `renderer/services/export-service.js`, `main/utils/temp-retention.js`, `main/utils/compact-last-strip.js`, and `main/ipc/export-dxf.js` were intentionally left unchanged; compatibility depends on preserved original item ids and reused artifact paths.

## Use When

- Changing Sparrow seed selection, quality-run orchestration, or stop behavior.
- Adjusting how multi-sheet/body quality is scored before tail refinement, or how final-sheet tail refinement is generated.
- Investigating why export or preview should show chosen best run after multi-seed execution or final-sheet tail refinement.
- Adding tests around body-vs-last-sheet scoring, final-sheet replacement merging, or tail payload slicing.

## Do Not Use When

- Working on unrelated DXF import, contour detection, or export formatting tasks.
- Changing generic UI settings behavior with no nesting-run impact.

## Last Updated

- 2026-07-23 (added configurable Tail runs setting)
