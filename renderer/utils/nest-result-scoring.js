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
        stripCount: Infinity,
        minBodyDensity: 0,
        avgBodyDensity: 0,
        avgDensityExcludingLast: 0,
        totalItemCount: 0,
      };
    }

    const densities = strips.map(strip => effectiveStripDensity(strip, sheet));
    const bodyDensities = strips.length > 1 ? densities.slice(0, -1) : [];
    const avgDensityExcludingLast = bodyDensities.length
      ? bodyDensities.reduce((sum, density) => sum + density, 0) / bodyDensities.length
      : 0;
    const avgBodyDensity = avgDensityExcludingLast;
    const minBodyDensity = bodyDensities.length ? Math.min(...bodyDensities) : 0;
    const totalItemCount = strips.reduce((sum, strip) => sum + (Number(strip?.item_count) || 0), 0);

    return {
      stripCount: strips.length,
      minBodyDensity,
      avgBodyDensity,
      avgDensityExcludingLast,
      totalItemCount,
    };
  }

  function isNestSummaryBetter(candidateScore, currentScore) {
    if (!currentScore) return true;
    const tolerance = 1e-9;
    if ((candidateScore?.stripCount ?? Infinity) !== (currentScore?.stripCount ?? Infinity)) {
      return (candidateScore?.stripCount ?? Infinity) < (currentScore?.stripCount ?? Infinity);
    }
    if (((candidateScore?.minBodyDensity ?? 0) - (currentScore?.minBodyDensity ?? 0)) > tolerance) return true;
    if (((currentScore?.minBodyDensity ?? 0) - (candidateScore?.minBodyDensity ?? 0)) > tolerance) return false;
    if (((candidateScore?.avgBodyDensity ?? 0) - (currentScore?.avgBodyDensity ?? 0)) > tolerance) return true;
    if (((currentScore?.avgBodyDensity ?? 0) - (candidateScore?.avgBodyDensity ?? 0)) > tolerance) return false;
    if (((candidateScore?.avgDensityExcludingLast ?? 0) - (currentScore?.avgDensityExcludingLast ?? 0)) > tolerance) return true;
    if (((currentScore?.avgDensityExcludingLast ?? 0) - (candidateScore?.avgDensityExcludingLast ?? 0)) > tolerance) return false;
    return (candidateScore?.totalItemCount ?? 0) > (currentScore?.totalItemCount ?? 0);
  }

  globalScope.NestResultScoring = {
    effectiveStripDensity,
    scoreNestSummary,
    isNestSummaryBetter,
  };
})(typeof window !== 'undefined' ? window : globalThis);
