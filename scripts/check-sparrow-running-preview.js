'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const { compactLastStripArtifacts } = require('../main/utils/compact-last-strip');

function loadCollectRunningSparrowArtifacts() {
  const sparrowPath = path.join(__dirname, '..', 'main', 'ipc', 'sparrow.js');
  const source = fs.readFileSync(sparrowPath, 'utf-8');
  const sandbox = {
    require(request) {
      if (request === 'electron') {
        return {
          app: { isPackaged: false, getPath: () => os.tmpdir(), on() {} },
          ipcMain: { handle() {} },
        };
      }
      if (request === 'path') return path;
      if (request === 'fs') return fs;
      if (request === 'child_process') return { spawn() { throw new Error('spawn should not run in check'); } };
      if (request === '../utils/temp-retention') return { cleanupTempArtifacts() {} };
      if (request === '../utils/compact-last-strip') return { compactLastStripArtifacts };
      return require(request);
    },
    module: { exports: {} },
    exports: {},
    __dirname: path.dirname(sparrowPath),
    __filename: sparrowPath,
    console,
    process,
    Buffer,
    setTimeout,
    clearTimeout,
  };

  vm.runInNewContext(
    `${source}\nmodule.exports.__check = { collectRunningSparrowArtifacts };`,
    sandbox,
    { filename: sparrowPath }
  );

  return sandbox.module.exports.__check.collectRunningSparrowArtifacts;
}

const collectRunningSparrowArtifacts = loadCollectRunningSparrowArtifacts();

function run() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nest-sparrow-running-preview-'));
  const safeName = 'test_run';
  const outputDir = path.join(tmpRoot, 'output');
  fs.mkdirSync(outputDir, { recursive: true });

  const previewSvgPath = path.join(outputDir, `final_${safeName}.svg`);
  fs.writeFileSync(previewSvgPath, '<svg><defs><g id="item_1"></g></defs><use href="#item_1" /></svg>');

  const artifacts = collectRunningSparrowArtifacts(tmpRoot, safeName);

  assert.ok(artifacts?.summary, 'Should return running preview summary from final_<name>.svg');
  assert.equal(artifacts.summary.is_preview, true, 'Running summary should stay preview');
  assert.equal(artifacts.summary.strips.length, 1, 'Should expose one preview strip');
  assert.equal(artifacts.summary.strips[0].svg_path, previewSvgPath, 'Should point to root final preview svg');
  assert.equal(artifacts.summary.strips[0].item_count, 1, 'Should count placed items from preview svg');

  console.log('ok');
}

run();
