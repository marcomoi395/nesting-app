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

function makeSummary(strips) {
  return { strips };
}

// Priority 1: totalItemCount beats all
const moreItems = makeSummary([
  { density: 0.5, strip_width: 1000, strip_height: 1000, item_count: 4 },
  { density: 0.5, strip_width: 1000, strip_height: 1000, item_count: 2 }
]);
const fewerItems = makeSummary([
  { density: 0.9, strip_width: 500, strip_height: 1000, item_count: 3 }
]);
assert.equal(
  isNestSummaryBetter(scoreNestSummary(moreItems), scoreNestSummary(fewerItems)),
  true,
  'higher totalItemCount should win (no dropped parts)'
);

// Priority 2: stripCount is second (with equal totalItemCount)
const oneStrip = makeSummary([
  { density: 0.5, strip_width: 2000, strip_height: 1000, item_count: 5 }
]);
const twoStrips = makeSummary([
  { density: 0.9, strip_width: 1000, strip_height: 1000, item_count: 3 },
  { density: 0.9, strip_width: 1000, strip_height: 1000, item_count: 2 }
]);
assert.equal(
  isNestSummaryBetter(scoreNestSummary(oneStrip), scoreNestSummary(twoStrips)),
  true,
  'fewer strips should win when totalItemCount is equal'
);

// Priority 3: lastStripWidth is third (with equal totalItemCount and stripCount)
const narrowerTail = makeSummary([
  { density: 0.7, strip_width: 1000, strip_height: 1000, item_count: 3 },
  { density: 0.7, strip_width: 800, strip_height: 1000, item_count: 2 }
]);
const widerTail = makeSummary([
  { density: 0.9, strip_width: 1000, strip_height: 1000, item_count: 3 },
  { density: 0.9, strip_width: 1200, strip_height: 1000, item_count: 2 }
]);
assert.equal(
  isNestSummaryBetter(scoreNestSummary(narrowerTail), scoreNestSummary(widerTail)),
  true,
  'smaller lastStripWidth should win when totalItemCount and stripCount are equal'
);

// Priority 4: bodyScore is fourth (sum of squared densities of body sheets)
const greedyBody = makeSummary([
  { density: 0.95, strip_width: 1000, strip_height: 1000, item_count: 2 },
  { density: 0.95, strip_width: 1000, strip_height: 1000, item_count: 2 },
  { density: 0.5, strip_width: 1000, strip_height: 1000, item_count: 1 }
]);
const weakBody = makeSummary([
  { density: 0.7, strip_width: 1000, strip_height: 1000, item_count: 2 },
  { density: 0.7, strip_width: 1000, strip_height: 1000, item_count: 2 },
  { density: 0.5, strip_width: 1000, strip_height: 1000, item_count: 1 }
]);
assert.equal(
  isNestSummaryBetter(scoreNestSummary(greedyBody), scoreNestSummary(weakBody)),
  true,
  'higher bodyScore (squared body densities) should win when totalItemCount, stripCount, lastStripWidth are equal'
);

// Priority 5: lastDensity is final tie-breaker
const betterLast = makeSummary([
  { density: 0.8, strip_width: 1000, strip_height: 1000, item_count: 3 },
  { density: 0.9, strip_width: 1000, strip_height: 1000, item_count: 2 }
]);
const worseLast = makeSummary([
  { density: 0.8, strip_width: 1000, strip_height: 1000, item_count: 3 },
  { density: 0.6, strip_width: 1000, strip_height: 1000, item_count: 2 }
]);
assert.equal(
  isNestSummaryBetter(scoreNestSummary(betterLast), scoreNestSummary(worseLast)),
  true,
  'higher lastDensity should win when all other metrics are equal'
);

// Tie: identical scores should not replace current
const identical1 = makeSummary([
  { density: 0.8, strip_width: 1000, strip_height: 1000, item_count: 3 }
]);
const identical2 = makeSummary([
  { density: 0.8, strip_width: 1000, strip_height: 1000, item_count: 3 }
]);
assert.equal(
  isNestSummaryBetter(scoreNestSummary(identical2), scoreNestSummary(identical1)),
  false,
  'identical scores should return false (keep current)'
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
