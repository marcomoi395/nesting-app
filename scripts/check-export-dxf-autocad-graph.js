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

function parseGroups(text) {
  const lines = text.split(/\r\n|\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  assert.equal(lines.length % 2, 0, 'DXF should contain code/value pairs');
  const groups = [];
  for (let i = 0; i < lines.length; i += 2) {
    groups.push({ code: lines[i], value: lines[i + 1] });
  }
  return groups;
}

function collectHandleGraph(groups) {
  const handles = new Set();
  const duplicates = new Set();
  const refs = [];
  let acadver = null;

  for (let i = 0; i < groups.length; i += 1) {
    const group = groups[i];
    const next = groups[i + 1] || null;
    if (group.code === '5') {
      if (handles.has(group.value)) duplicates.add(group.value);
      handles.add(group.value);
    }
    if (['330', '340', '350', '360', '390'].includes(group.code)) {
      refs.push(group);
    }
    if (group.code === '9' && group.value === '$ACADVER' && next && next.code === '1') {
      acadver = next.value;
    }
  }

  const dangling = refs.filter(group => group.value !== '0' && !handles.has(group.value));
  return { handles, duplicates: Array.from(duplicates), dangling, acadver };
}

async function main() {
  const handler = loadExportHandler();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nest-dxf-graph-'));
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
        shape: { data: [[0, 0], [40, 0], [40, 40], [0, 40]] },
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
        part_label: 'sample',
        layers: [{ name: 'mỏng', color: '#ffffff' }],
        entities: [
          {
            type: 'CIRCLE',
            layer: 'mỏng',
            center: { x: 8, y: 8, z: 0 },
            radius: 2,
          },
          {
            type: 'LWPOLYLINE',
            layer: 'mỏng',
            closed: true,
            vertices: [
              { x: 0, y: 0, bulge: 0.4142 },
              { x: 10, y: 0 },
              { x: 10, y: 10 },
              { x: 0, y: 10 },
            ],
          },
          {
            type: 'LINE',
            layer: 'mỏng',
            start: { x: 12, y: 0, z: 0 },
            end: { x: 18, y: 6, z: 0 },
          },
          {
            type: 'ARC',
            layer: 'mỏng',
            center: { x: 22, y: 8, z: 0 },
            radius: 3,
            startAngle: 0,
            endAngle: Math.PI / 2,
          },
        ],
        polygon: [[0, 0], [40, 0], [40, 40], [0, 40]],
      },
    },
    strips: [
      { index: 1, json_path: stripPath, strip_width: 40, strip_height: 40, sheet_width: 40 },
    ],
  });

  assert.equal(result?.success, true, 'mock export should succeed');
  const outPath = path.join(outputDir, '01_sheet_40x40.dxf');
  const text = fs.readFileSync(outPath, 'utf8');
  const groups = parseGroups(text);
  const graph = collectHandleGraph(groups);

  assert.equal(graph.acadver, 'AC1021', 'DXF should emit AC1021 header');
  assert.equal(graph.duplicates.length, 0, `duplicate handles found: ${graph.duplicates.join(', ')}`);
  assert.equal(graph.dangling.length, 0, `dangling handle refs found: ${graph.dangling.map(group => `${group.code}:${group.value}`).join(', ')}`);
  assert.match(text, /0\r\nSECTION\r\n2\r\nHEADER\r\n/, 'missing HEADER section');
  assert.match(text, /0\r\nSECTION\r\n2\r\nTABLES\r\n/, 'missing TABLES section');
  assert.match(text, /0\r\nSECTION\r\n2\r\nBLOCKS\r\n/, 'missing BLOCKS section');
  assert.match(text, /0\r\nSECTION\r\n2\r\nENTITIES\r\n/, 'missing ENTITIES section');
  assert.match(text, /0\r\nSECTION\r\n2\r\nOBJECTS\r\n/, 'missing OBJECTS section');
  assert.ok(text.endsWith('0\r\nEOF\r\n'), 'DXF should end with EOF');
  assert.match(text, /\*Model_Space/, 'expected *Model_Space block record');
  assert.match(text, /\*Paper_Space/, 'expected *Paper_Space block record');
  assert.ok(!text.includes('mỏng'), 'DXF should not contain raw non-ASCII layer names');
  assert.match(text, /\bmong\b/, 'DXF should contain sanitized ASCII layer name');

  console.log('DXF AutoCAD graph check passed:', outPath);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
