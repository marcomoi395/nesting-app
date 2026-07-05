'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const repoRoot = path.resolve(__dirname, '..');
const exportFile = path.join(repoRoot, 'main', 'ipc', 'export-dxf.js');

function loadExportHandler() {
  let handler = null;
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        ipcMain: {
          handle(name, fn) {
            if (name === 'export-sheets-dxf') handler = fn;
          },
        },
      };
    }
    if (request.endsWith('security-scoped-bookmarks')) {
      return {
        withSecurityScopedAccess: async (_bookmark, fn) => fn(),
      };
    }
    return originalLoad.apply(this, arguments);
  };

  try {
    delete require.cache[require.resolve(exportFile)];
    const mod = require(exportFile);
    mod.registerExportDxfIpc();
  } finally {
    Module._load = originalLoad;
  }

  assert.equal(typeof handler, 'function', 'export-sheets-dxf handler should register');
  return handler;
}

async function main() {
  const handler = loadExportHandler();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nest-dxf-check-'));
  const outputDir = path.join(tempRoot, 'out');
  const inputPath = path.join(tempRoot, 'input.json');
  const stripPath = path.join(tempRoot, 'strip.json');

  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(inputPath, JSON.stringify({
    settings: {},
    items: [
      {
        id: 1,
        dxf: 'sample.dxf',
        shape: { data: [[0, 0], [10, 0], [10, 10], [0, 10]] },
      },
    ],
  }));
  fs.writeFileSync(stripPath, JSON.stringify({
    solution: {
      layout: {
        placed_items: [
          { item_id: 1, transformation: { rotation: 0, translation: [0, 0] } },
        ],
      },
    },
  }));

  const result = await handler({}, {
    outputDir,
    outputDirBookmark: null,
    jobName: 'job',
    inputPath,
    exportItems: {
      1: {
        source_name: 'sample.dxf',
        layers: [{ name: 'mỏng', color: '#ffffff' }],
        entities: [
          {
            type: 'LINE',
            layer: 'mỏng',
            start: { x: 0, y: 0, z: 0 },
            end: { x: 10, y: 0, z: 0 },
          },
        ],
        polygon: [[0, 0], [10, 0], [10, 10], [0, 10]],
      },
    },
    strips: [
      { index: 1, json_path: stripPath, strip_width: 10, strip_height: 10, sheet_width: 10 },
    ],
  });

  assert.equal(result?.success, true, 'mock export should succeed');
  const outPath = path.join(outputDir, '01_sheet_10x10.dxf');
  const text = fs.readFileSync(outPath, 'utf8');

  assert.ok(!text.includes('AC1014'), 'DXF should no longer emit brittle AC1014 header');
  assert.ok(!text.includes('mỏng'), 'DXF should not contain non-ASCII layer names');
  assert.match(text, /\bmong\b/, 'DXF should contain sanitized ASCII layer name');
  assert.match(text, /0\r\nSECTION\r\n2\r\nHEADER\r\n/, 'DXF should contain HEADER section');
  assert.match(text, /0\r\nSECTION\r\n2\r\nCLASSES\r\n/, 'DXF should contain CLASSES section');
  assert.match(text, /0\r\nSECTION\r\n2\r\nTABLES\r\n/, 'DXF should contain TABLES section');
  assert.match(text, /0\r\nSECTION\r\n2\r\nBLOCKS\r\n/, 'DXF should contain BLOCKS section');
  assert.match(text, /0\r\nSECTION\r\n2\r\nENTITIES\r\n/, 'DXF should contain ENTITIES section');
  assert.match(text, /0\r\nSECTION\r\n2\r\nOBJECTS\r\n/, 'DXF should contain OBJECTS section');
  assert.ok(text.includes('\r\n'), 'DXF should use CRLF newlines');
  assert.ok(text.endsWith('\r\n'), 'DXF should end with trailing newline');

  console.log('DXF export clean check passed:', outPath);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
