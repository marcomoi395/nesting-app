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

[
  'renderer/utils/nest-result-scoring.js',
  'renderer/utils/tail-refinement.js',
].forEach(file => {
  const source = fs.readFileSync(path.join(repoRoot, file), 'utf8');
  vm.runInContext(source, context, { filename: file });
});

const {
  shouldSkipTailRefinement,
  buildTailRefinementCandidates,
  buildTailSubsetPayload,
  mergeTailReplacement,
  scoreTailRefinementSummary,
  isTailRefinementBetter,
} = context.NestTailRefinement;
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

const payload = {
  name: 'sample-job',
  items: [
    { id: 1, demand: 99, meta: 'a' },
    { id: 2, demand: 99, meta: 'b' },
    { id: 3, demand: 99, meta: 'c' },
    { id: 4, demand: 99, meta: 'd' },
  ],
};

const summary = {
  strip_count: 3,
  strips: [
    {
      index: 1,
      density: 0.4,
      strip_width: 900,
      strip_height: 1000,
      item_count: 2,
      placed_item_counts: [
        { item_id: 1, count: 2 },
      ],
    },
    {
      index: 2,
      density: 0.5,
      strip_width: 800,
      strip_height: 1000,
      item_count: 3,
      placed_item_counts: [
        { item_id: 2, count: 1 },
        { item_id: 3, count: 2 },
      ],
    },
    {
      index: 3,
      density: 0.3,
      strip_width: 700,
      strip_height: 1000,
      item_count: 4,
      placed_item_counts: [
        { item_id: 2, count: 2 },
        { item_id: 4, count: 2 },
      ],
    },
  ],
};
assert.equal(
  shouldSkipTailRefinement(summary, { widthMode: 'unlimited' }),
  true,
  'unlimited mode should always skip tail refinement'
);
assert.equal(
  shouldSkipTailRefinement({ strips: [{}] }, { widthMode: 'fixed' }),
  true,
  'single-strip fixed result should skip tail refinement'
);
assert.equal(
  shouldSkipTailRefinement(summary, { widthMode: 'max' }),
  false,
  'multi-strip max result should still allow tail refinement'
);

const candidates = buildTailRefinementCandidates(summary, payload);
assert.deepEqual(
  plain(candidates.map(candidate => candidate.id)),
  ['last-only'],
  'three-strip summary should produce only last-only candidate'
);
assert.deepEqual(
  plain(candidates[0].itemCounts),
  [
    { item_id: 2, count: 2 },
    { item_id: 4, count: 2 },
  ],
  'last-only should use only final strip item counts'
);

const subsetPayload = buildTailSubsetPayload(payload, candidates[0]);
assert.equal(subsetPayload.name, 'sample-job_tail_last-only');
assert.deepEqual(
  plain(subsetPayload.items),
  [
    { id: 0, demand: 2, meta: 'b' },
    { id: 1, demand: 2, meta: 'd' },
  ],
  'subset payload should remap ids to 0-based and rewrite demand to last strip counts'
);
assert.deepEqual(
  plain(subsetPayload._tailIdMapping),
  { '0': 2, '1': 4 },
  'subset payload should include reverse id mapping'
);

const merged = mergeTailReplacement(summary, {
  strips: [
    {
      index: 1,
      density: 0.75,
      strip_width: 600,
      strip_height: 1000,
      item_count: 4,
      placed_item_counts: candidates[0].itemCounts,
    },
  ],
}, candidates[0]);
assert.equal(merged.strip_count, 3, 'replacing last strip with one refined strip should keep strip count');
assert.equal(merged.strips.length, 3, 'merged summary should keep strip list length when replacing one strip with one strip');
assert.equal(merged.strips[2].index, 3, 'replacement strip should be renumbered into merged position');

assert.equal(
  mergeTailReplacement(summary, { strips: [{}, {}] }, candidates[0]),
  null,
  'last-only replacement returning two strips should be rejected'
);

const sheet = { widthMode: 'fixed', width: 1000, height: 1000 };
const shorterLowerDensityLast = scoreTailRefinementSummary({
  strips: [
    { density: 0.6, strip_width: 1000, strip_height: 1000, item_count: 3 },
    { density: 0.5, strip_width: 800, strip_height: 1000, item_count: 3 },
  ],
}, sheet);
const longerHigherDensityLast = scoreTailRefinementSummary({
  strips: [
    { density: 0.6, strip_width: 1000, strip_height: 1000, item_count: 3 },
    { density: 0.7, strip_width: 1000, strip_height: 1000, item_count: 3 },
  ],
}, sheet);
assert.equal(
  isTailRefinementBetter(shorterLowerDensityLast, longerHigherDensityLast),
  true,
  'fixed-mode tail scoring should prefer shorter last sheet before density'
);

const fewerStripsWorseTail = scoreTailRefinementSummary({
  strips: [
    { density: 0.4, strip_width: 1000, strip_height: 1000, item_count: 6 },
  ],
}, sheet);
assert.equal(
  isTailRefinementBetter(fewerStripsWorseTail, longerHigherDensityLast),
  true,
  'fewer strips should still win even with lower tail quality'
);
const maxModeShorterLast = scoreTailRefinementSummary({
  strips: [
    { density: 0.6, strip_width: 1000, strip_height: 1000, item_count: 3 },
    { density: 0.5, strip_width: 780, strip_height: 1000, item_count: 3 },
  ],
}, { widthMode: 'max', width: 1000, height: 1000 });
const maxModeLongerLast = scoreTailRefinementSummary({
  strips: [
    { density: 0.6, strip_width: 1000, strip_height: 1000, item_count: 3 },
    { density: 0.7, strip_width: 950, strip_height: 1000, item_count: 3 },
  ],
}, { widthMode: 'max', width: 1000, height: 1000 });
assert.equal(
  isTailRefinementBetter(maxModeShorterLast, maxModeLongerLast),
  true,
  'max-mode tail scoring should prefer shorter last sheet before density'
);

const sameDensityNarrowerLast = scoreTailRefinementSummary({
  strips: [
    { density: 0.6, strip_width: 1000, strip_height: 1000, item_count: 3 },
    { density: 0.7, strip_width: 900, strip_height: 1000, item_count: 3 },
  ],
}, { widthMode: 'unlimited' });
const sameDensityWiderLast = scoreTailRefinementSummary({
  strips: [
    { density: 0.6, strip_width: 1000, strip_height: 1000, item_count: 3 },
    { density: 0.7, strip_width: 1000, strip_height: 1000, item_count: 3 },
  ],
}, { widthMode: 'unlimited' });
assert.equal(
  isTailRefinementBetter(sameDensityNarrowerLast, sameDensityWiderLast),
  true,
  'when last density ties, narrower last strip should win'
);

console.log('ok');
