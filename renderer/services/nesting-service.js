  'use strict';

  (function defineNestingService(globalScope) {
    function createNestingService({
    state,
    dom,
    getCurrentNestingSettings,
    exportPlacementJSON,
    setStatus,
    setNestStatsTone,
    showNestResult,
    renderTabs,
      syncExportButton,
    }) {
      const {
        MULTI_SHEET_STRATEGY_OPTIONS = {
          'auto': { multiStripMode: 'barriers', bucketFillWeight: null },
          'by-height': { multiStripMode: 'prebucket', bucketFillWeight: 1.0 },
          'by-length': { multiStripMode: 'prebucket', bucketFillWeight: 0.0 },
          'by-height-or-length': { multiStripMode: 'prebucket', bucketFillWeight: null },
        },
      } = globalScope.NestSettings || {};
      const { scoreNestSummary, isNestSummaryBetter } = globalScope.NestResultScoring || {};
      const {
        shouldSkipTailRefinement,
        buildTailRefinementCandidates,
        buildTailSubsetPayload,
        mergeTailReplacement,
        scoreTailRefinementSummary,
        isTailRefinementBetter,
      } = globalScope.NestTailRefinement || {};
      let nestInterval = null;
      let sparrowRunAborted = false;
      let activeSparrowRunId = null;

    // Parses raw stdout/stderr from the solver binary into a clean one-line message.
    // Prefers explicit "error:" lines, falls back to the last non-info line, then to raw text.
    function extractSparrowErrorMessage(...chunks) {
      const text = chunks.map(chunk => String(chunk || '')).filter(Boolean).join('\n').trim();
      if (!text) return 'Sparrow failed';

      const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      const explicitError = [...lines].reverse().find(line => /^error:/i.test(line));
      if (explicitError) return explicitError.replace(/^error:\s*/i, '').trim();
      const stripLength = [...lines].reverse().find(line => /requires strip length .* exceeding the configured maximum/i.test(line));
      if (stripLength) return stripLength;
      const lastMeaningful = [...lines].reverse().find(line => !/^\[info\]/i.test(line));
      return lastMeaningful || lines[lines.length - 1] || 'Sparrow failed';
    }

    // Sets the status chip to error, tints the status bar red, and writes the error
    // message with a tooltip containing the full solver details for debugging.
    function showRunError(message, details = '') {
      setStatus('error');
      setNestStatsTone('error');
      const summary = message || 'Sparrow failed';
      dom.nestStats.textContent = `Run failed: ${summary}`;
      dom.nestStats.title = details || summary;
    }

    // Shows a gentle preflight hint when Run is pressed before the user has
    // added the required DXF parts and/or sheets.
    function showStartRequirementsWarning(message) {
      setStatus('idle');
      setNestStatsTone('warning');
      dom.nestStats.textContent = message;
      dom.nestStats.title = '';
    }
    function delay(ms) {
      return new Promise(resolve => window.setTimeout(resolve, ms));
    }

    function qualityRunCount(settings) {
      return Math.max(1, Math.min(5, Math.trunc(Number(settings.multiSeedQualityRuns) || 1)));
    }

    function qualityRunSeeds(settings, count) {
      const base = Number.isFinite(Number(settings.rngSeed)) ? Math.trunc(Number(settings.rngSeed)) : 42;
      return [base, base + 101, base + 1009, base + 10007, base + 100003].slice(0, count);
    }
    function tailRefinementEnabled(settings) {
      return qualityRunCount(settings) > 1;
    }

    function tailRefinementSeeds(settings) {
      const count = Math.max(1, Math.min(5, Math.trunc(Number(settings.tailRuns) || 1)));
      return qualityRunSeeds(settings, count);
    }

    function tailRefinementOptions(baseOptions, settings) {
      return {
        ...baseOptions,
        maxStripLength: null,
        globalTime: Math.max(1, Number(settings.timeLimit) || 60),
        earlyTermination: !!settings.earlyStopping,
      };
    }

    function setRunControlsRunning() {
      setStatus('running');
      setNestStatsTone('');
      dom.startBtn.classList.add('running');
      dom.startBtn.disabled = true;
      dom.stopBtn.disabled = false;
      dom.stopBtn.classList.add('active');
    }

    function setRunControlsDone() {
      setStatus('done');
      setNestStatsTone('');
      dom.nestStats.title = '';
      dom.startBtn.classList.remove('running');
      dom.startBtn.disabled = false;
      dom.stopBtn.disabled = true;
      dom.stopBtn.classList.remove('active');
    }

    async function waitForSparrowCompletion(runId) {
      const progressText = dom.nestStats.textContent;
      let result = await pollSparrowRun(runId);
      while (!sparrowRunAborted) {
        if (result?.status === 'completed' || result?.status === 'stopped') return result;
        dom.nestStats.textContent = progressText;
        dom.nestStats.title = '';
        await delay(500);
        result = await pollSparrowRun(runId);
      }
      return { success: true, status: 'stopped' };
    }

    async function runQualitySeedSequence(payload, baseOptions, settings) {
      if (typeof scoreNestSummary !== 'function' || typeof isNestSummaryBetter !== 'function') {
        throw new Error('Nest result scoring is unavailable');
      }

      const seeds = qualityRunSeeds(settings, qualityRunCount(settings));
      let best = null;
      let firstError = null;

      for (const [index, seed] of seeds.entries()) {
        try {
          if (sparrowRunAborted) return null;
          setRunControlsRunning();
          dom.nestStats.textContent = `Quality run ${index + 1}/${seeds.length} · seed ${seed}`;
          dom.nestStats.title = '';
          const result = await window.electronAPI.runSparrow(payload, { ...baseOptions, rngSeed: seed });
          if (!result?.success || !result.runId) {
            throw new Error(result?.error || 'Failed to start Sparrow');
          }

          activeSparrowRunId = result.runId;
          const completed = await waitForSparrowCompletion(result.runId);
          if (completed.status === 'stopped') return null;
          if (completed.summary?.strips?.length) {
            const finalSummary = await runTailRefinement(completed.summary, payload, baseOptions, settings);
            if (finalSummary === null) return null;
            const score = scoreNestSummary(finalSummary, state.sheets[0] || {});
            if (!best || isNestSummaryBetter(score, best.score)) {
              best = {
                seed,
                score,
                summary: finalSummary,
                inputPath: completed.inputPath || result.inputPath || null,
              };
            }
          }
        } catch (err) {
          if (!firstError) firstError = err;
          activeSparrowRunId = null;
          console.warn('[Sparrow] Quality seed failed:', seed, err?.sparrowDetails || err);
          try {
            await window.electronAPI.stopSparrow?.();
          } catch (stopError) {
            console.warn('[Sparrow] Cleanup stop after quality seed failure failed:', stopError);
          }
        }
      }

      if (!best) throw firstError || new Error('No successful quality run');
      return best;
    }
    async function runTailRefinement(baseSummary, payload, baseOptions, settings) {
      const sheet = state.sheets[0] || {};
      if (
        typeof shouldSkipTailRefinement === 'function'
        && shouldSkipTailRefinement(baseSummary, sheet)
      ) {
        return baseSummary;
      }
      if (
        typeof buildTailRefinementCandidates !== 'function'
        || typeof buildTailSubsetPayload !== 'function'
        || typeof mergeTailReplacement !== 'function'
        || typeof scoreTailRefinementSummary !== 'function'
        || typeof isTailRefinementBetter !== 'function'
      ) {
        console.warn('[Sparrow] Tail refinement unavailable');
        return baseSummary;
      }
      if (!tailRefinementEnabled(settings)) return baseSummary;

      const candidates = buildTailRefinementCandidates(baseSummary, payload);
      if (!candidates.length) return baseSummary;

      const seeds = tailRefinementSeeds(settings);
      const options = tailRefinementOptions(baseOptions, settings);
      let bestSummary = baseSummary;
      let bestScore = scoreTailRefinementSummary(baseSummary, sheet);
      let attempted = 0;

      for (const candidate of candidates) {
        for (const seed of seeds) {
          if (sparrowRunAborted) return null;
          setRunControlsRunning();
          attempted += 1;
          dom.nestStats.textContent = 'Tail optimize ' + attempted + '/' + (candidates.length * seeds.length) + ' · ' + candidate.label + ' · seed ' + seed;
          dom.nestStats.title = '';
          const tailPayload = buildTailSubsetPayload(payload, candidate);
          try {
            const result = await window.electronAPI.runSparrow(tailPayload, { ...options, rngSeed: seed });
            if (!result?.success || !result.runId) {
              console.warn('[Sparrow] Tail refinement candidate failed:', candidate.id, seed, result?.error || 'Failed to start Sparrow');
              activeSparrowRunId = null;
              try {
                await window.electronAPI.stopSparrow?.();
              } catch (stopError) {
                console.warn('[Sparrow] Cleanup stop after tail refinement launch failure failed:', stopError);
              }
              continue;
            }
            activeSparrowRunId = result.runId;
            const completed = await waitForSparrowCompletion(result.runId);
            if (completed.status === 'stopped') return null;
            const merged = mergeTailReplacement(baseSummary, completed.summary, candidate);
            if (merged === null) continue;
            const score = scoreTailRefinementSummary(merged, sheet);
            if (isTailRefinementBetter(score, bestScore)) {
              bestSummary = merged;
              bestScore = score;
            }
          } catch (err) {
            console.warn('[Sparrow] Tail refinement candidate failed:', candidate.id, seed, err?.sparrowDetails || err);
            activeSparrowRunId = null;
            try {
              await window.electronAPI.stopSparrow?.();
            } catch (stopError) {
              console.warn('[Sparrow] Cleanup stop after tail refinement failure failed:', stopError);
            }
          }
        }
      }

      return bestSummary;
    }

    // Called on a 500ms interval while the solver is running to fetch the latest result.
    // Updates state and re-renders the canvas whenever new strips arrive, and cleans up
    // the interval on completion, error, or stop.
    async function pollSparrowRun(runId) {
      if (!window.electronAPI?.pollSparrow) return;

      const result = await window.electronAPI.pollSparrow(runId);
      if (!result?.success) {
        throw new Error(result?.error || 'Failed to poll Sparrow run');
      }

      if (result.summary?.strips?.length) {
        const previousCount = state.nestResult?.strips?.length || 0;
        const previousIndex = state.activeStripIndex || 0;
        state.nestResult = result.summary;
        if (result.inputPath) state.nestInputPath = result.inputPath;

        if (previousCount === 0) {
          // First time strips become available this run. Default to sheet 1
          // so the user lands on the natural starting point. (Barrier mode
          // loads every sheet on the first poll, so without this guard the
          // newest-strip auto-follow below would jump straight to the last
          // tab.)
          state.activeStripIndex = 0;
        } else if (state.nestResult.strips.length > previousCount) {
          // Pre-bucket mode: Sparrow finishes one sheet at a time. Follow
          // the newest one so the user sees the sheet currently being
          // populated instead of staying pinned to an older tab.
          state.activeStripIndex = state.nestResult.strips.length - 1;
        } else if (!state.nestResult.strips[previousIndex]) {
          state.activeStripIndex = 0;
        }
        syncExportButton();
        renderTabs();
        showNestResult(state.activeStripIndex || 0);
      } else if (result.status === 'running') {
        setNestStatsTone('');
        dom.nestStats.textContent = 'Running placement… waiting for first preview';
      }

      if (result.status === 'completed') {
        clearInterval(nestInterval);
        nestInterval = null;
        activeSparrowRunId = null;
        setStatus('done');
        setNestStatsTone('');
        dom.nestStats.title = '';
        dom.startBtn.classList.remove('running');
        dom.startBtn.disabled = false;
        dom.stopBtn.disabled = true;
        dom.stopBtn.classList.remove('active');
        return result;
      }

      if (result.status === 'error') {
        clearInterval(nestInterval);
        nestInterval = null;
        activeSparrowRunId = null;
        const combinedDetails = [result.error, result.stderr, result.stdout].filter(Boolean).join('\n');
        const err = new Error(extractSparrowErrorMessage(result.error, result.stderr, result.stdout));
        err.sparrowDetails = combinedDetails;
        throw err;
      }

      if (result.status === 'stopped') {
        clearInterval(nestInterval);
        nestInterval = null;
        activeSparrowRunId = null;
        return result;
      }

      return result;
    }

    // Wires the Start and Stop buttons.
    // Start: exports the placement JSON, launches Sparrow via IPC, and begins a 500ms
    // polling interval. Stop: sets the abort flag, calls stopSparrow, and resets the UI.
    function bind() {
      // Start button — exports placement JSON, runs Sparrow, and starts polling for results.
      dom.startBtn.addEventListener('click', async () => {
        if (state.status === 'running') return;

        const hasFiles = state.files.length > 0;
        const hasSheets = state.sheets.length > 0;
        if (!hasFiles && !hasSheets) {
          showStartRequirementsWarning('Add DXF parts and at least one sheet, then press Run.');
          return;
        }
        if (!hasFiles) {
          showStartRequirementsWarning('Add one or more DXF parts before running nesting.');
          return;
        }
        if (!hasSheets) {
          showStartRequirementsWarning('Add at least one sheet before running nesting.');
          return;
        }

        let exported;
        try {
          exported = await exportPlacementJSON();
          setNestStatsTone('');
          dom.nestStats.textContent = 'Placement data prepared';
          dom.nestStats.title = exported.path || '';
        } catch (err) {
          console.error('[Placement JSON] Export failed:', err);
          setStatus('error');
          setNestStatsTone('error');
          dom.nestStats.textContent = `Export failed: ${err.message}`;
          return;
        }

        setRunControlsRunning();
        dom.nestStats.title = '';
        sparrowRunAborted = false;
        state.nestResult = null;
        state.activeStripIndex = 0;
        syncExportButton();

        try {
          const primarySheet = state.sheets[0] || {};
          const settings = getCurrentNestingSettings();
          const runCount = qualityRunCount(settings);
          const partSpacing = Number(settings.partSpacing) || 0;
          // Single multi-sheet strategy drives both the placement algorithm
          // (`multiStripMode`) and, for the legacy bucketed paths, the
          // bucket fill weight. `bucketFillWeight: null` means "omit from
          // the CLI" — handled by the spread below.
          const strategyKey = String(settings.multiSheetStrategy || 'auto').toLowerCase();
          const strategy = MULTI_SHEET_STRATEGY_OPTIONS[strategyKey]
            || MULTI_SHEET_STRATEGY_OPTIONS['auto'];
          const { multiStripMode, bucketFillWeight } = strategy;
          const sparrowOptions = {
            globalTime: Number(settings.timeLimit) || 60,
            rngSeed: Number.isFinite(Number(settings.rngSeed)) ? Math.trunc(Number(settings.rngSeed)) : 42,
            workers: Number.isFinite(Number(settings.workers)) ? Math.max(1, Math.trunc(Number(settings.workers))) : 3,
            earlyTermination: !!settings.earlyStopping,
            maxStripLength: primarySheet.widthMode === 'unlimited' ? null : Number(primarySheet.width) || null,
            stripMargin: Number(settings.sheetMargin) || 0,
            minItemSeparation: partSpacing,
            exactCoedge: partSpacing === 0,
            align: String(settings.preferredAlignment || 'top'),
            multiStripMode,
            ...(Number.isFinite(bucketFillWeight) ? { bucketFillWeight } : {}),
          };

          if (runCount > 1) {
            const best = await runQualitySeedSequence(exported.payload, sparrowOptions, settings);
            if (best === null) return;
            state.nestResult = best.summary;
            state.nestInputPath = best.inputPath;
            state.activeStripIndex = Math.min(state.activeStripIndex || 0, Math.max(0, (best.summary.strips?.length || 1) - 1));
            syncExportButton();
            renderTabs();
            showNestResult(state.activeStripIndex || 0);
            setRunControlsDone();
            dom.nestStats.title = `Best quality seed: ${best.seed}`;
            return;
          }

          const result = await window.electronAPI.runSparrow(exported.payload, sparrowOptions);

          if (!result?.success || !result.runId) {
            throw new Error(result?.error || 'Failed to start Sparrow');
          }
          activeSparrowRunId = result.runId;
          setNestStatsTone('');
          dom.nestStats.textContent = 'Placement running…';
          dom.nestStats.title = result.inputPath || '';

          if (nestInterval) clearInterval(nestInterval);
          await pollSparrowRun(result.runId);
          nestInterval = window.setInterval(async () => {
            if (!activeSparrowRunId || sparrowRunAborted) return;
            try {
              await pollSparrowRun(activeSparrowRunId);
            } catch (pollError) {
              if (sparrowRunAborted) return;
              console.error('[Sparrow] Live preview failed:', pollError?.sparrowDetails || pollError);
              clearInterval(nestInterval);
              nestInterval = null;
              activeSparrowRunId = null;
              showRunError(pollError.message, pollError?.sparrowDetails || pollError.message);
              dom.startBtn.classList.remove('running');
              dom.startBtn.disabled = false;
              dom.stopBtn.disabled = true;
              dom.stopBtn.classList.remove('active');
            }
          }, 150);
        } catch (err) {
          if (sparrowRunAborted) return;
          console.error('[Sparrow] Run failed:', err?.sparrowDetails || err);
          activeSparrowRunId = null;
          if (nestInterval) {
            clearInterval(nestInterval);
            nestInterval = null;
          }
          showRunError(err.message, err?.sparrowDetails || err.message);
          dom.startBtn.classList.remove('running');
          dom.startBtn.disabled = false;
          dom.stopBtn.disabled = true;
          dom.stopBtn.classList.remove('active');
        }
      });

      // Stop button — sets the abort flag, tells the main process to stop Sparrow,
      // clears the polling interval, and resets the UI to idle.
      dom.stopBtn.addEventListener('click', async () => {
        if (state.status !== 'running') return;
        sparrowRunAborted = true;
        activeSparrowRunId = null;
        if (window.electronAPI?.stopSparrow) {
          try {
            await window.electronAPI.stopSparrow();
          } catch (err) {
            console.error('[Sparrow] Stop failed:', err);
          }
        }
        clearInterval(nestInterval);
        nestInterval = null;
        setStatus('idle');
        setNestStatsTone('');
        dom.nestStats.textContent = 'Placement stopped';
        dom.nestStats.title = '';
        dom.startBtn.classList.remove('running');
        dom.startBtn.disabled = false;
        dom.stopBtn.disabled = true;
        dom.stopBtn.classList.remove('active');
      });
    }

    return { bind };
  }

  globalScope.NestNestingService = { createNestingService };
})(window);
