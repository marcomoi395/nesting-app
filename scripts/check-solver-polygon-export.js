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

for (const file of ['renderer/helpers.js', 'renderer/services/dxf-service.js']) {
  const source = fs.readFileSync(path.join(repoRoot, file), 'utf8');
  vm.runInContext(source, context, { filename: file });
}

const state = {
  files: [{
    id: 'f1',
    name: 'TEXT 11.dxf',
    path: '/tmp/TEXT 11.dxf',
    qty: 1,
    _multiSketchDetection: false,
    _sketchContourMethod: 'auto',
    layers: [{ name: 'Layer 1', color: '#fff' }],
    shapes: [{
      id: 'shape_0',
      qty: 1,
      visible: true,
      polygonPoints: [
        { x: 603857.1093, y: 209084.3825 },
        { x: 603887.1093, y: 209084.3825 },
        { x: 603918.1093, y: 209084.3825 },
        { x: 603918.1093, y: 208543.3825 },
        { x: 603677.1093, y: 208543.3825 },
        { x: 603677.1093, y: 208754.3825 },
        { x: 603857.1093, y: 209084.3825 },
      ],
      holes: [{
        points: [
          { x: 603760, y: 208700 },
          { x: 603780, y: 208700 },
          { x: 603780, y: 208720 },
          { x: 603760, y: 208720 },
          { x: 603760, y: 208700 },
        ],
      }],
      exportEntities: [{
        type: 'LINE',
        layer: 'CUT',
        start: { x: 603677.1093, y: 208543.3825, z: 0 },
        end: { x: 603918.1093, y: 209084.3825, z: 0 },
      }],
    }],
  }],
  sheets: [{ id: 'sheet1', width: 6000, height: 2000, widthMode: 'fixed', material: '' }],
};

const service = context.NestDxfService.createDxfService({
  state,
  getCurrentNestingSettings: () => ({
    rotationStep: '90',
    engravingLayer: 'off',
    multiSketchDetection: false,
    sketchContourMethod: 'auto',
  }),
});

(async () => {
  const payload = await service.buildPlacementPayload();
  const outer = payload.items[0].shape.data;
  const hole = state.lastPlacementExportItems[0].holes[0];
  const exportEntity = state.lastPlacementExportItems[0].entities[0];

  const xs = outer.map(([x]) => x);
  const ys = outer.map(([, y]) => y);

  assert.equal(Math.min(...xs), 0, 'outer ring should be normalized to local min x');
  assert.equal(Math.min(...ys), 0, 'outer ring should be normalized to local min y');
  assert.notDeepEqual(outer[0], outer[outer.length - 1], 'outer ring should not repeat first point at end');
  assert.equal(outer.length, 5, 'collinear closing/export noise should be removed');
  assert.equal(JSON.stringify(hole), JSON.stringify([
    [82.8907, 156.6175],
    [102.8907, 156.6175],
    [102.8907, 176.6175],
    [82.8907, 176.6175],
  ]), 'hole should keep same relative offset under shared origin');
  assert.equal(exportEntity.start.x, 0, 'export entity start.x should share polygon local origin');
  assert.equal(exportEntity.start.y, 0, 'export entity start.y should share polygon local origin');
  assert.equal(exportEntity.end.x, 241, 'export entity end.x should be translated into local space');
  assert.equal(exportEntity.end.y, 541, 'export entity end.y should be translated into local space');

  console.log('ok');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
