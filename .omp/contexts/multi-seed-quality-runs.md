# Multi-seed Sparrow Quality-Run Selection

## Summary

- `Quality runs` is visible in Algorithm settings and defaults to `1`, so normal behavior stays single-run until user opts in.
- Multi-seed mode runs Sparrow sequentially with deterministic seeds derived from `rngSeed`: `[base, base + 101, base + 1009, base + 10007, base + 100003]`, capped to 5 runs.
- Best result selection is lexicographic: fewer strips first, then better tail-sheet utilization, then average utilization, then total item count.
- Tail quality scoring uses fixed-width density correction matching display/export behavior, so chosen result aligns with visible utilization.
- Best run is applied by setting `state.nestResult` and `state.nestInputPath`; export and canvas code stay unchanged.

## Details

- Scoring lives in `renderer/utils/nest-result-scoring.js` and exports global `NestResultScoring` with `effectiveStripDensity`, `scoreNestSummary`, and `isNestSummaryBetter`.
- Empty or missing strip summaries score as `{ stripCount: Infinity, minTailDensity: 0, avgTailDensity: 0, avgDensity: 0, totalItemCount: 0 }`.
- Tail means last 3 strips by default. Tie-break order is:
  1. smaller `stripCount`
  2. higher `minTailDensity`
  3. higher `avgTailDensity`
  4. higher `avgDensity`
  5. higher `totalItemCount`
- Renderer orchestrates quality runs in `renderer/services/nesting-service.js` without new IPC. Existing `runSparrow`, `pollSparrow`, `stopSparrow` stay canonical.
- Stop button still aborts whole sequence through existing `stopSparrow()` behavior.
- One failed seed does not fail sequence if another seed succeeds. If all seeds fail, first error is surfaced.
- During quality runs, status text is restored to `Quality run X/Y · seed Z` between polls so sequence progress stays visible.

## Evidence

- `user-stated`: approved plan required default single-run behavior, visible `Quality runs`, deterministic seed list, tail-priority scoring, and no IPC changes.
- `code-verified`: `renderer/index.html` adds `Quality runs` input and loads `utils/nest-result-scoring.js` before renderer services.
- `code-verified`: `shared/settings.js` adds `multiSeedQualityRuns: 1` and clamps it to `[1, 5]`.
- `code-verified`: `renderer/services/nesting-service.js` adds `runQualitySeedSequence`, `qualityRunSeeds`, `qualityRunCount`, and best-result finalization through `state.nestResult` / `state.nestInputPath`.
- `code-verified`: `renderer/services/export-service.js` and `renderer/views/canvas-view.js` were intentionally left unchanged; compatibility depends on writing chosen best result back into shared state.
- `test-verified`: `node scripts/check-nest-result-scoring.js` printed `ok`.
- `test-verified`: `node scripts/check-solver-polygon-export.js` printed `ok` after change.
- `test-verified`: `node --check renderer/utils/nest-result-scoring.js`, `node --check renderer/services/nesting-service.js`, `node --check shared/settings.js`, and `node --check scripts/check-nest-result-scoring.js` all passed.

## Use When

- Changing Sparrow seed selection, run orchestration, or stop behavior.
- Adjusting how multi-sheet/tail quality is scored.
- Investigating why export or preview should show chosen best run after multi-seed execution.
- Adding tests around nesting result ranking or fixed-width density handling.

## Do Not Use When

- Working on unrelated DXF import, contour detection, or export formatting tasks.
- Changing generic UI settings behavior with no nesting-run impact.

## Last Updated

- 2026-07-04
