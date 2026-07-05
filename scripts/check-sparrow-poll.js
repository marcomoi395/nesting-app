'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { awaitCompletedArtifacts } = require('../main/ipc/sparrow');

async function run() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nest-sparrow-poll-'));
  const safeName = 'test_run';
  const finalDir = path.join(tmpRoot, 'output', `final_${safeName}`);
  fs.mkdirSync(finalDir, { recursive: true });

  const summaryPath = path.join(finalDir, 'summary.json');
  const stripJsonPath = path.join(tmpRoot, 'strip_1.json');
  const stripSvgPath = path.join(tmpRoot, 'strip_1.svg');

  // Background task: final files arrive after 150ms
  setTimeout(() => {
    fs.writeFileSync(stripSvgPath, '<svg />');
    fs.writeFileSync(stripJsonPath, JSON.stringify({
      solution: { layout: { placed_items: [] } },
    }));
    fs.writeFileSync(summaryPath, JSON.stringify({
      strips: [{
        index: 1,
        json_path: path.relative(tmpRoot, stripJsonPath),
        svg_path: path.relative(tmpRoot, stripSvgPath),
      }],
      is_preview: false,
    }));
  }, 150);

  // Poll starting now (final files missing initially)
  const artifacts = await awaitCompletedArtifacts(tmpRoot, safeName, {
    attempts: 10,
    delayMs: 50,
  });

  assert.equal(artifacts.summary.is_preview, false, 'Should wait and return final non-preview summary');
  assert.equal(artifacts.summary.strips[0].json_path, stripJsonPath, 'Should resolve absolute json path');

  console.log('ok');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
