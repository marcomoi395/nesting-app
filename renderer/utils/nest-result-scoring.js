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

  function scoreNestSummary(summary, sheet = {}, tailCount = 3) {
    const strips = Array.isArray(summary?.strips) ? summary.strips : [];
    if (!strips.length) {
      return {
        stripCount: Infinity,
        minTailDensity: 0,
        avgTailDensity: 0,
        avgDensity: 0,
        totalItemCount: 0,
      };
    }

    const densities = strips.map(strip => effectiveStripDensity(strip, sheet));
    const tailSize = Math.min(Math.max(0, Math.trunc(Number(tailCount) || 0)), strips.length);
    const tailDensities = tailSize > 0 ? densities.slice(-tailSize) : [];
    const avgDensity = densities.reduce((sum, density) => sum + density, 0) / densities.length;
    const avgTailDensity = tailDensities.length
      ? tailDensities.reduce((sum, density) => sum + density, 0) / tailDensities.length
      : 0;
    const minTailDensity = tailDensities.length ? Math.min(...tailDensities) : 0;
    const totalItemCount = strips.reduce((sum, strip) => sum + (Number(strip?.item_count) || 0), 0);

    return {
      stripCount: strips.length,
      minTailDensity,
      avgTailDensity,
      avgDensity,
      totalItemCount,
    };
  }

  function isNestSummaryBetter(candidateScore, currentScore) {
    if (!currentScore) return true;
    const tolerance = 1e-9;
    if ((candidateScore?.stripCount ?? Infinity) !== (currentScore?.stripCount ?? Infinity)) {
      return (candidateScore?.stripCount ?? Infinity) < (currentScore?.stripCount ?? Infinity);
    }
    if (((candidateScore?.minTailDensity ?? 0) - (currentScore?.minTailDensity ?? 0)) > tolerance) return true;
    if (((currentScore?.minTailDensity ?? 0) - (candidateScore?.minTailDensity ?? 0)) > tolerance) return false;
    if (((candidateScore?.avgTailDensity ?? 0) - (currentScore?.avgTailDensity ?? 0)) > tolerance) return true;
    if (((currentScore?.avgTailDensity ?? 0) - (candidateScore?.avgTailDensity ?? 0)) > tolerance) return false;
    if (((candidateScore?.avgDensity ?? 0) - (currentScore?.avgDensity ?? 0)) > tolerance) return true;
    if (((currentScore?.avgDensity ?? 0) - (candidateScore?.avgDensity ?? 0)) > tolerance) return false;
    return (candidateScore?.totalItemCount ?? 0) > (currentScore?.totalItemCount ?? 0);
  }

  globalScope.NestResultScoring = {
    effectiveStripDensity,
    scoreNestSummary,
    isNestSummaryBetter,
  };
})(typeof window !== 'undefined' ? window : globalThis);
