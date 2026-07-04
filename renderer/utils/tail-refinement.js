'use strict';

(function defineTailRefinement(globalScope) {
  function itemCountsToMap(counts) {
    const map = new Map();
    (Array.isArray(counts) ? counts : []).forEach(entry => {
      const itemId = Number(entry?.item_id);
      const count = Math.trunc(Number(entry?.count));
      if (!Number.isFinite(itemId) || count <= 0) return;
      map.set(itemId, count);
    });
    return map;
  }

  function mapToSortedCounts(map) {
    return [...map.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([item_id, count]) => ({ item_id, count }));
  }

  function hasUsablePlacedItemCounts(strip) {
    return itemCountsToMap(strip?.placed_item_counts).size > 0;
  }

  function combineTailCounts(strips) {
    const combined = new Map();
    strips.forEach(strip => {
      itemCountsToMap(strip?.placed_item_counts).forEach((count, itemId) => {
        combined.set(itemId, (combined.get(itemId) || 0) + count);
      });
    });
    return mapToSortedCounts(combined);
  }

  function buildTailRefinementCandidates(summary, payload, options = {}) {
    void payload;
    void options;
    const strips = Array.isArray(summary?.strips) ? summary.strips : [];
    if (strips.length < 1) return [];
    const lastStrip = strips[strips.length - 1];
    if (!hasUsablePlacedItemCounts(lastStrip)) return [];

    return [{
      id: 'last-only',
      label: 'last sheet',
      replaceStartIndex: strips.length - 1,
      maxReplacementStrips: 1,
      itemCounts: combineTailCounts([lastStrip]),
      sourceStripCount: 1,
    }];
  }

  function buildTailSubsetPayload(payload, candidate) {
    const itemCounts = itemCountsToMap(candidate?.itemCounts);
    const baseName = payload?.name || 'nesting-job';
    const filteredItems = (Array.isArray(payload?.items) ? payload.items : [])
      .filter(item => itemCounts.has(Number(item?.id)));
    const idMapping = {};
    const remappedItems = filteredItems.map((item, index) => {
      idMapping[index] = Number(item.id);
      return { ...item, id: index, demand: itemCounts.get(Number(item.id)) };
    });
    return {
      ...payload,
      name: `${baseName}_tail_${candidate?.id}`,
      items: remappedItems,
      _tailIdMapping: idMapping,
    };
  }

  function mergeTailReplacement(baseSummary, replacementSummary, candidate) {
    const baseStrips = Array.isArray(baseSummary?.strips) ? baseSummary.strips : [];
    const replacementStrips = Array.isArray(replacementSummary?.strips) ? replacementSummary.strips : [];
    if (replacementStrips.length < 1 || replacementStrips.length > Number(candidate?.maxReplacementStrips)) return null;
    const mergedStrips = [
      ...baseStrips.slice(0, Number(candidate?.replaceStartIndex) || 0),
      ...replacementStrips.map((strip, offset) => ({
        ...strip,
        index: (Number(candidate?.replaceStartIndex) || 0) + offset + 1,
      })),
    ];
    return {
      ...baseSummary,
      strips: mergedStrips,
      strip_count: mergedStrips.length,
      is_preview: false,
    };
  }

  function scoreTailRefinementSummary(summary, sheet) {
    const strips = Array.isArray(summary?.strips) ? summary.strips : [];
    if (!strips.length) {
      return {
        stripCount: Infinity,
        lastDensity: 0,
        minTailDensity: 0,
        avgTailDensity: 0,
        lastStripWidth: Infinity,
        totalItemCount: 0,
      };
    }

    const scoreApi = globalScope.NestResultScoring || {};
    const densityOf = typeof scoreApi.effectiveStripDensity === 'function'
      ? strip => scoreApi.effectiveStripDensity(strip, sheet)
      : () => 0;
    const densities = strips.map(densityOf);
    const tailDensities = densities.slice(-Math.min(3, densities.length));
    const lastStrip = strips[strips.length - 1] || {};
    const lastDensity = densities[densities.length - 1] || 0;
    const minTailDensity = tailDensities.length ? Math.min(...tailDensities) : 0;
    const avgTailDensity = tailDensities.length
      ? tailDensities.reduce((sum, density) => sum + density, 0) / tailDensities.length
      : 0;
    const lastStripWidth = Number(lastStrip.strip_width) || Infinity;
    const totalItemCount = strips.reduce((sum, strip) => sum + (Number(strip?.item_count) || 0), 0);

    return {
      stripCount: strips.length,
      lastDensity,
      minTailDensity,
      avgTailDensity,
      lastStripWidth,
      totalItemCount,
    };
  }

  function isTailRefinementBetter(candidateScore, currentScore) {
    if (!currentScore) return true;
    const tolerance = 1e-9;
    if ((candidateScore?.stripCount ?? Infinity) !== (currentScore?.stripCount ?? Infinity)) {
      return (candidateScore?.stripCount ?? Infinity) < (currentScore?.stripCount ?? Infinity);
    }
    if (((candidateScore?.lastDensity ?? 0) - (currentScore?.lastDensity ?? 0)) > tolerance) return true;
    if (((currentScore?.lastDensity ?? 0) - (candidateScore?.lastDensity ?? 0)) > tolerance) return false;
    if (((candidateScore?.minTailDensity ?? 0) - (currentScore?.minTailDensity ?? 0)) > tolerance) return true;
    if (((currentScore?.minTailDensity ?? 0) - (candidateScore?.minTailDensity ?? 0)) > tolerance) return false;
    if (((candidateScore?.avgTailDensity ?? 0) - (currentScore?.avgTailDensity ?? 0)) > tolerance) return true;
    if (((currentScore?.avgTailDensity ?? 0) - (candidateScore?.avgTailDensity ?? 0)) > tolerance) return false;
    if (((currentScore?.lastStripWidth ?? Infinity) + tolerance) < (candidateScore?.lastStripWidth ?? Infinity)) return false;
    if (((candidateScore?.lastStripWidth ?? Infinity) + tolerance) < (currentScore?.lastStripWidth ?? Infinity)) return true;
    return (candidateScore?.totalItemCount ?? 0) > (currentScore?.totalItemCount ?? 0);
  }

  globalScope.NestTailRefinement = {
    itemCountsToMap,
    buildTailRefinementCandidates,
    buildTailSubsetPayload,
    mergeTailReplacement,
    scoreTailRefinementSummary,
    isTailRefinementBetter,
  };
})(typeof window !== 'undefined' ? window : globalThis);
