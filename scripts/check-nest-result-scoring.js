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
  'fewer strips should beat better tail utilization'
);

const weakerMinTail = summaryFromTailDensities([0.6, 0.6, 0.6, 0.5, 0.5, 0.5]);
const strongerMinTail = summaryFromTailDensities([0.6, 0.6, 0.6, 0.5, 0.5, 0.7]);
assert.equal(
  isNestSummaryBetter(scoreNestSummary(strongerMinTail), scoreNestSummary(weakerMinTail)),
  true,
  'higher min tail density should win when strip count matches'
);

const lowerAvgTail = summaryFromTailDensities([0.4, 0.4, 0.4, 0.5, 0.5, 0.9]);
const higherAvgTail = summaryFromTailDensities([0.4, 0.4, 0.4, 0.5, 0.6, 0.9]);
const lowerAvgScore = scoreNestSummary(lowerAvgTail);
const higherAvgScore = scoreNestSummary(higherAvgTail);
assert.equal(lowerAvgScore.minTailDensity, higherAvgScore.minTailDensity, 'test setup should tie min tail density');
assert.equal(
  isNestSummaryBetter(higherAvgScore, lowerAvgScore),
  true,
  'higher avg tail density should win after min tail tie'
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
