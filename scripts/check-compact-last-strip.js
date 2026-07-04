'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { compactLastStripArtifacts } = require('../main/utils/compact-last-strip');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nest-compact-last-strip-'));
const jsonPath = path.join(tmpRoot, 'strip_02.json');
const svgPath = path.join(tmpRoot, 'strip_02.svg');

fs.writeFileSync(jsonPath, JSON.stringify({
  name: 'demo_strip_02',
  items: [
    {
      id: 0,
      shape: {
        type: 'simple_polygon',
        data: [[0, 0], [40, 0], [40, 20], [0, 20]],
      },
    },
    {
      id: 1,
      shape: {
        type: 'simple_polygon',
        data: [[0, 0], [20, 0], [20, 10], [0, 10]],
      },
    },
  ],
  solution: {
    strip_width: 200,
    layout: {
      placed_items: [
        { item_id: 0, transformation: { rotation: 0, translation: [60, 30] } },
        { item_id: 1, transformation: { rotation: 0, translation: [120, 50] } },
      ],
      density: 0.3,
    },
    density: 0.3,
  },
}, null, 2));

fs.writeFileSync(svgPath, [
  '<svg viewBox="0 0 200 100" xmlns="http://www.w3.org/2000/svg">',
  '<g id="items">',
  '<use href="#item_0" transform="translate(60 30), rotate(0)"/>',
  '<use href="#item_1" transform="translate(120 50), rotate(0)"/>',
  '</g>',
  '<g id="optionals">',
  '<g id="highlight_cd_shapes">',
  '<use href="#cd_shape_0" transform="translate(60 30), rotate(0)"/>',
  '<use href="#cd_shape_1" transform="translate(120 50), rotate(0)"/>',
  '</g>',
  '</g>',
  '</svg>',
].join('\n'));

const summary = {
  strips: [
    { index: 1, json_path: path.join(tmpRoot, 'strip_01.json'), svg_path: path.join(tmpRoot, 'strip_01.svg'), svg: '<svg />' },
    { index: 2, json_path: jsonPath, svg_path: svgPath, svg: fs.readFileSync(svgPath, 'utf8') },
  ],
};

const updated = compactLastStripArtifacts(summary);
const updatedJson = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
const translations = updatedJson.solution.layout.placed_items.map(item => item.transformation.translation[0]);
assert.deepEqual(translations, [0, 60], 'last strip should shift whole cluster left until min x is zero');

const updatedSvg = fs.readFileSync(svgPath, 'utf8');
assert.match(updatedSvg, /translate\(0(?:\.0+)? 30\)/, 'svg item use should shift left');
assert.match(updatedSvg, /translate\(60(?:\.0+)? 50\)/, 'svg second item use should preserve spacing after left shift');
assert.equal(updated.strips[0].json_path, summary.strips[0].json_path, 'earlier strips should stay untouched');
assert.match(updated.strips[1].svg, /translate\(0(?:\.0+)? 30\)/, 'returned summary should carry updated svg text for last strip');

console.log('ok');
