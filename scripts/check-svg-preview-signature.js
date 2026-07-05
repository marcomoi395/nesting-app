'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function run() {
  const dir = path.join(__dirname, '..', 'output', 'sols_TEXT 11 2');
  const a = fs.readFileSync(path.join(dir, '124_1771.184_cmpr.svg'), 'utf-8');
  const b = fs.readFileSync(path.join(dir, '125_1771.082_cmpr.svg'), 'utf-8');

  assert.notEqual(a, b, 'Adjacent solver frames should differ byte-for-byte');
  assert.equal(a === b, false, 'Exact SVG equality should keep adjacent frames distinct');

  console.log('ok');
}

run();
