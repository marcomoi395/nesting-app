'use strict';

const fs = require('node:fs');

function roundCoord(value) {
  return Number(value.toFixed(6));
}

function transformPoint(point, rotationDeg, translation) {
  const [tx, ty] = Array.isArray(translation) ? translation : [0, 0];
  const radians = (Number(rotationDeg) || 0) * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const x = Number(point?.[0]);
  const y = Number(point?.[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {
    x: (x * cos) - (y * sin) + tx,
    y: (x * sin) + (y * cos) + ty,
  };
}

function polygonMinX(item, placement) {
  const points = Array.isArray(item?.shape?.data) ? item.shape.data : [];
  if (!points.length) return Infinity;
  const rotation = Number(placement?.transformation?.rotation) || 0;
  const translation = placement?.transformation?.translation;
  let minX = Infinity;
  for (const point of points) {
    const transformed = transformPoint(point, rotation, translation);
    if (!transformed) continue;
    if (transformed.x < minX) minX = transformed.x;
  }
  return minX;
}

function shiftSvgText(svgText, shiftX) {
  return String(svgText || '').replace(/translate\(\s*([\-\d.]+)(?:[\s,]+([\-\d.]+))\s*\)/g, (_, xRaw, yRaw) => {
    const x = Number(xRaw);
    const y = Number(yRaw);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return _;
    return `translate(${roundCoord(x + shiftX)} ${roundCoord(y)})`;
  });
}

function compactLastStripArtifacts(summary) {
  const strips = Array.isArray(summary?.strips) ? summary.strips : [];
  if (!strips.length) return summary;

  const lastIndex = strips.length - 1;
  const lastStrip = strips[lastIndex];
  if (!lastStrip?.json_path || !fs.existsSync(lastStrip.json_path)) return summary;

  let stripData;
  try {
    stripData = JSON.parse(fs.readFileSync(lastStrip.json_path, 'utf8'));
  } catch {
    return summary;
  }

  const placedItems = Array.isArray(stripData?.solution?.layout?.placed_items)
    ? stripData.solution.layout.placed_items
    : [];
  const items = Array.isArray(stripData?.items) ? stripData.items : [];
  if (!placedItems.length || !items.length) return summary;

  const itemsById = new Map(items.map(item => [item.id, item]));
  const minX = placedItems.reduce((acc, placement) => {
    const item = itemsById.get(placement?.item_id);
    return Math.min(acc, polygonMinX(item, placement));
  }, Infinity);
  if (!Number.isFinite(minX) || minX <= 1e-6) return summary;

  const shiftX = -minX;
  placedItems.forEach(placement => {
    const translation = placement?.transformation?.translation;
    if (!Array.isArray(translation) || translation.length < 2) return;
    const nextX = Number(translation[0]);
    const nextY = Number(translation[1]);
    if (!Number.isFinite(nextX) || !Number.isFinite(nextY)) return;
    placement.transformation.translation = [roundCoord(nextX + shiftX), roundCoord(nextY)];
  });
  fs.writeFileSync(lastStrip.json_path, `${JSON.stringify(stripData, null, 2)}\n`);

  let nextSvg = lastStrip.svg || '';
  if (lastStrip.svg_path && fs.existsSync(lastStrip.svg_path)) {
    nextSvg = shiftSvgText(fs.readFileSync(lastStrip.svg_path, 'utf8'), shiftX);
    fs.writeFileSync(lastStrip.svg_path, nextSvg);
  }

  const nextStrips = strips.slice();
  nextStrips[lastIndex] = {
    ...lastStrip,
    svg: nextSvg,
  };
  return {
    ...summary,
    strips: nextStrips,
  };
}

module.exports = {
  compactLastStripArtifacts,
};
