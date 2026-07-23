'use strict';

(function defineNestResultScoring(globalScope) {
  function effectiveStripDensity(strip, sheet = {}) {
    const rawDensity = Number(strip?.density);
    if (!Number.isFinite(rawDensity) || rawDensity <= 0) return 0;
    if (sheet?.widthMode !== 'fixed') return rawDensity;

    const rawWidth = Number(strip?.strip_width);
    const rawHeight = Number(strip?.strip_height) || Number(sheet?.height);
    const configuredWidth = Number(sheet?.width);
    if (!Number.isFinite(rawWidth) || rawWidth <= 0
      || !Number.isFinite(rawHeight) || rawHeight <= 0
      || !Number.isFinite(configuredWidth) || configuredWidth <= 0) {
      return rawDensity;
    }

    const usedArea = rawDensity * rawWidth * rawHeight;
    const fixedArea = configuredWidth * rawHeight;
    if (!Number.isFinite(fixedArea) || fixedArea <= 0) return rawDensity;
    return usedArea / fixedArea;
  }

  function scoreNestSummary(summary, sheet = {}) {
    const strips = Array.isArray(summary?.strips) ? summary.strips : [];
    if (!strips.length) {
      return {
        totalItemCount: 0,
        stripCount: Infinity,
        lastStripWidth: Infinity,
        lastDensity: 0,
        bodyScore: 0,
      };
    }

    const totalItemCount = strips.reduce((sum, strip) => sum + (Number(strip?.item_count) || 0), 0);
    const stripCount = strips.length;
    const lastStrip = strips[strips.length - 1];
    const lastStripWidth = Number(lastStrip?.strip_width) || Infinity;
    const lastDensity = effectiveStripDensity(lastStrip, sheet);

    // Body score: sum of squared densities for all strips except the last
    let bodyScore = 0;
    if (strips.length > 1) {
      const bodyStrips = strips.slice(0, -1);
      bodyScore = bodyStrips.reduce((sum, strip) => {
        const density = effectiveStripDensity(strip, sheet);
        return sum + Math.pow(density, 2);
      }, 0);
    }

    return {
      totalItemCount,
      stripCount,
      lastStripWidth,
      lastDensity,
      bodyScore,
    };
  }

  function isNestSummaryBetter(candidateScore, currentScore) {
    if (!currentScore) return true;

    const EPSILON = 0.0001;

    // Priority 1: totalItemCount (higher is better - no dropped parts)
    if (candidateScore.totalItemCount > currentScore.totalItemCount) return true;
    if (candidateScore.totalItemCount < currentScore.totalItemCount) return false;

    // Priority 2: stripCount (lower is better - fewer sheets)
    if (candidateScore.stripCount < currentScore.stripCount) return true;
    if (candidateScore.stripCount > currentScore.stripCount) return false;

    // Priority 3: lastStripWidth (lower is better - more reusable tail)
    if (currentScore.lastStripWidth - candidateScore.lastStripWidth > EPSILON) return true;
    if (candidateScore.lastStripWidth - currentScore.lastStripWidth > EPSILON) return false;

    // Priority 4: bodyScore (higher is better - greedy body packing)
    if (candidateScore.bodyScore - currentScore.bodyScore > EPSILON) return true;
    if (currentScore.bodyScore - candidateScore.bodyScore > EPSILON) return false;

    // Priority 5: lastDensity (higher is better - tie-breaker)
    if (candidateScore.lastDensity - currentScore.lastDensity > EPSILON) return true;

    // Tie: keep current
    return false;
  }

  globalScope.NestResultScoring = {
    effectiveStripDensity,
    scoreNestSummary,
    isNestSummaryBetter,
  };
})(typeof window !== 'undefined' ? window : globalThis);
