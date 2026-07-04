'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repoRoot = path.join(__dirname, '..');
const context = {
  console,
  window: {},
};
context.window = context;
context.global = context;
context.globalThis = context;
vm.createContext(context);

const source = fs.readFileSync(path.join(repoRoot, 'renderer/utils/nest-result-scoring.js'), 'utf8');
vm.runInContext(source, context, { filename: 'renderer/utils/nest-result-scoring.js' });

const {
  effectiveStripDensity,
  scoreNestSummary,
  isNestSummaryBetter,
} = context.NestResultScoring;

function summaryFromTailDensities(densities) {
  return {
    strips: densities.map((density, index) => ({
      density,
      strip_width: 1000,
      strip_height: 1000,
      item_count: index + 1,
    })),
  };
}

const eightStrip = summaryFromTailDensities([0.55, 0.55, 0.55, 0.55, 0.55, 0.55, 0.2, 0.2]);
const nineStrip = summaryFromTailDensities([0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.95, 0.95, 0.95]);
assert.equal(
  isNestSummaryBetter(scoreNestSummary(eightStrip), scoreNestSummary(nineStrip)),
  true,
  'fewer strips should still win first'
);

const weakerBodySameLast = summaryFromTailDensities([0.6, 0.6, 0.6, 0.5, 0.5, 0.5]);
const strongerBodySameLast = summaryFromTailDensities([0.6, 0.6, 0.6, 0.5, 0.7, 0.5]);
assert.equal(
  isNestSummaryBetter(scoreNestSummary(strongerBodySameLast), scoreNestSummary(weakerBodySameLast)),
  true,
  'higher body density should win when strip count matches'
);

const sameBodyWeakerLast = summaryFromTailDensities([0.4, 0.4, 0.4, 0.5, 0.5, 0.6]);
const sameBodyStrongerLast = summaryFromTailDensities([0.4, 0.4, 0.4, 0.5, 0.5, 0.95]);
assert.equal(
  isNestSummaryBetter(scoreNestSummary(sameBodyStrongerLast), scoreNestSummary(sameBodyWeakerLast)),
  false,
  'phase 1 scoring should ignore last sheet quality when earlier sheets tie'
);

assert.equal(
  effectiveStripDensity(
    { density: 0.5, strip_width: 500, strip_height: 1000 },
    { widthMode: 'fixed', width: 1000, height: 1000 }
  ),
  0.25,
  'fixed-width density correction should rescale by configured width'
);

console.log('ok');
