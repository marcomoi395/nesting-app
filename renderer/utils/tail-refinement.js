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
  function shouldSkipTailRefinement(summary, sheet) {
    const strips = Array.isArray(summary?.strips) ? summary.strips : [];
    if (!strips.length) return true;
    if (sheet?.widthMode === 'unlimited') return true;
    if (strips.length <= 1) return true;
    return false;
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
        preferShortLastStrip: sheet?.widthMode === 'fixed' || sheet?.widthMode === 'max',
        lastDensity: 0,
        lastStripWidth: Infinity,
        totalItemCount: 0,
      };
    }

    const scoreApi = globalScope.NestResultScoring || {};
    const densityOf = typeof scoreApi.effectiveStripDensity === 'function'
      ? strip => scoreApi.effectiveStripDensity(strip, sheet)
      : () => 0;
    const lastStrip = strips[strips.length - 1] || {};
    const lastDensity = densityOf(lastStrip);
    const lastStripWidth = Number(lastStrip.strip_width) || Infinity;
    const totalItemCount = strips.reduce((sum, strip) => sum + (Number(strip?.item_count) || 0), 0);

    return {
      stripCount: strips.length,
      preferShortLastStrip: sheet?.widthMode === 'fixed' || sheet?.widthMode === 'max',
      lastDensity,
      lastStripWidth,
      totalItemCount,
    };
  }

  function isTailRefinementBetter(candidateScore, currentScore) {
    if (!currentScore) return true;
    const tolerance = 1e-9;
    
    // Priority 1: totalItemCount (never accept dropped parts)
    if ((candidateScore?.totalItemCount ?? 0) > (currentScore?.totalItemCount ?? 0)) return true;
    if ((candidateScore?.totalItemCount ?? 0) < (currentScore?.totalItemCount ?? 0)) return false;
    
    // Priority 2: stripCount (fewer sheets better)
    if ((candidateScore?.stripCount ?? Infinity) !== (currentScore?.stripCount ?? Infinity)) {
      return (candidateScore?.stripCount ?? Infinity) < (currentScore?.stripCount ?? Infinity);
    }
    
    // Priority 3: mode-dependent tail quality
    if (candidateScore?.preferShortLastStrip || currentScore?.preferShortLastStrip) {
      if (((currentScore?.lastStripWidth ?? Infinity) - (candidateScore?.lastStripWidth ?? Infinity)) > tolerance) return true;
      if (((candidateScore?.lastStripWidth ?? Infinity) - (currentScore?.lastStripWidth ?? Infinity)) > tolerance) return false;
      if (((candidateScore?.lastDensity ?? 0) - (currentScore?.lastDensity ?? 0)) > tolerance) return true;
      if (((currentScore?.lastDensity ?? 0) - (candidateScore?.lastDensity ?? 0)) > tolerance) return false;
      return false;
    }
    if (((candidateScore?.lastDensity ?? 0) - (currentScore?.lastDensity ?? 0)) > tolerance) return true;
    if (((currentScore?.lastDensity ?? 0) - (candidateScore?.lastDensity ?? 0)) > tolerance) return false;
    if (((currentScore?.lastStripWidth ?? Infinity) - (candidateScore?.lastStripWidth ?? Infinity)) > tolerance) return true;
    if (((candidateScore?.lastStripWidth ?? Infinity) - (currentScore?.lastStripWidth ?? Infinity)) > tolerance) return false;
    return false;
  }

  globalScope.NestTailRefinement = {
    itemCountsToMap,
    shouldSkipTailRefinement,
    buildTailRefinementCandidates,
    buildTailSubsetPayload,
    mergeTailReplacement,
    scoreTailRefinementSummary,
    isTailRefinementBetter,
  };
})(typeof window !== 'undefined' ? window : globalThis);
