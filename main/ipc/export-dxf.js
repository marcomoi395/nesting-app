const { ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { normalizeSettings } = require('../../shared/settings');
const { withSecurityScopedAccess } = require('../utils/security-scoped-bookmarks');
const {
  layoutEngravingLabel,
  DEFAULT_LAYOUT: ENGRAVING_LAYOUT_DEFAULTS,
  engravingLabelText,
  engravingVisualStyle,
} = require('../../shared/engraving-layout');
const { DxfWriter, point2d, point3d, LWPolylineFlags, PolylineFlags, SplineFlags, Units } = require('@tarikjabiri/dxf');

const FALLBACK_LAYER_COLORS = ['#4f8ef7', '#f75f5f', '#4fcf8e', '#f7c34f', '#cf4ff7', '#4ff7e8', '#f77f4f'];

function registerExportDxfIpc() {
  // Write one DXF per strip using placement data from the strip JSON files.
  ipcMain.handle('export-sheets-dxf', async (event, {
    outputDir,
    outputDirBookmark,
    jobName,
    inputPath,
    exportItems = {},
    strips,
  }) => {
    try {
      return await withSecurityScopedAccess(outputDirBookmark, async () => {
      fs.mkdirSync(outputDir, { recursive: true });
      const globalItemsById = {};
      const exportSettings = normalizeSettings({});
      if (inputPath && fs.existsSync(inputPath)) {
        try {
          const inputData = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
          Object.assign(exportSettings, normalizeSettings(inputData.settings || {}));
          (inputData.items || []).forEach(item => { globalItemsById[item.id] = item; });
        } catch (e) {
          // Fall through — will export what it can.
        }
      }

      const RAD = Math.PI / 180;
      const DEG = 180 / Math.PI;

      function overwriteTextFile(targetPath, contents) {
        const dir = path.dirname(targetPath);
        const base = path.basename(targetPath);
        const tempPath = path.join(dir, `.${base}.${process.pid}.${Date.now()}.tmp`);

        try {
          fs.writeFileSync(tempPath, normalizeDxfText(contents), 'utf-8');
          if (fs.existsSync(targetPath)) fs.rmSync(targetPath, { force: true });
          fs.renameSync(tempPath, targetPath);

          // Touch the replacement so downstream apps that key off modified time
          // notice the update even when the filename stays the same.
          const now = new Date();
          fs.utimesSync(targetPath, now, now);
        } catch (error) {
          try {
            if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
          } catch {
            // Ignore temp cleanup failures and surface the original write error.
          }
          throw error;
        }
      }

      function applyTransform(pts, rotation, tx, ty) {
        const cos = Math.cos(rotation * RAD);
        const sin = Math.sin(rotation * RAD);
        return pts.map(([x, y]) => [
          +(cos * x - sin * y + tx).toFixed(4),
          +(sin * x + cos * y + ty).toFixed(4),
        ]);
      }

      function transformPoint(pt, rotation, tx, ty) {
        const cos = Math.cos(rotation * RAD);
        const sin = Math.sin(rotation * RAD);
        const x = Number(pt?.x || 0);
        const y = Number(pt?.y || 0);
        return {
          x: +(cos * x - sin * y + tx).toFixed(4),
          y: +(sin * x + cos * y + ty).toFixed(4),
          z: Number.isFinite(pt?.z) ? +pt.z.toFixed(4) : 0,
        };
      }

      function rotateVector(pt, rotation) {
        const cos = Math.cos(rotation * RAD);
        const sin = Math.sin(rotation * RAD);
        const x = Number(pt?.x || 0);
        const y = Number(pt?.y || 0);
        return {
          x: +(cos * x - sin * y).toFixed(4),
          y: +(sin * x + cos * y).toFixed(4),
          z: Number.isFinite(pt?.z) ? +pt.z.toFixed(4) : 0,
        };
      }

      function normalizeDegrees(value) {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) return 0;
        return ((numeric % 360) + 360) % 360;
      }

      function roundUpDim(mm) {
        const numeric = Number(mm);
        return Number.isFinite(numeric) && numeric > 0 ? Math.ceil(numeric) : 0;
      }
      function sanitizeDxfName(value, fallback = '0') {
        const raw = String(value == null ? '' : value).trim();
        if (!raw) return fallback;
        const ascii = raw
          .normalize('NFKD')
          .replace(/[\u0300-\u036f]/g, '')
          .replace(/[^\x20-\x7E]/g, '_')
          .replace(/[^A-Za-z0-9 _.$-]/g, '_')
          .replace(/\s+/g, ' ')
          .trim();
        return ascii || fallback;
      }

      function normalizeDxfText(contents) {
        return String(contents).replace(/\r?\n/g, '\r\n').replace(/(?<!\r\n)$/u, '\r\n');
      }

      function exportSheetFileBase(strip, orderIndex) {
        const displayIndex = Number.isFinite(Number(orderIndex)) ? Number(orderIndex) + 1 : 1;
        const idx = String(displayIndex).padStart(2, '0');
        const width = roundUpDim(strip.sheet_width ?? strip.strip_width);
        const height = roundUpDim(strip.strip_height);
        return `${idx}_sheet_${height}x${width}`;
      }

      function polylineClosed(entity) {
        return !!(entity?.closed || entity?.shape || entity?.is3dPolygonMeshClosed);
      }

      function lwPolylineFlags(entity) {
        return (polylineClosed(entity) ? 1 : 0) |
          (entity?.hasContinuousLinetypePattern ? 128 : 0);
      }

      function polylineFlags(entity) {
        return (polylineClosed(entity) ? 1 : 0) |
          (entity?.includesCurveFitVertices ? 2 : 0) |
          (entity?.includesSplineFitVertices ? 4 : 0) |
          (entity?.is3dPolyline ? 8 : 0) |
          (entity?.is3dPolygonMesh ? 16 : 0) |
          (entity?.is3dPolygonMeshClosed ? 32 : 0) |
          (entity?.isPolyfaceMesh ? 64 : 0) |
          (entity?.hasContinuousLinetypePattern ? 128 : 0);
      }

      function polylineVertexFlags(vertex) {
        return (vertex?.curveFittingVertex ? 1 : 0) |
          (vertex?.curveFitTangent ? 2 : 0) |
          (vertex?.splineVertex ? 8 : 0) |
          (vertex?.splineControlPoint ? 16 : 0) |
          (vertex?.threeDPolylineVertex ? 32 : 0) |
          (vertex?.threeDPolylineMesh ? 64 : 0) |
          (vertex?.polyfaceMeshVertex ? 128 : 0);
      }

      function normalizeClosedPolylineVertices(vertices, closed) {
        if (!closed || !Array.isArray(vertices) || vertices.length < 2) return Array.isArray(vertices) ? vertices : [];
        const last = vertices[vertices.length - 1];
        if (!Number.isFinite(last?.bulge) || last.bulge === 0) return vertices;

        const zeroBulgeIndex = vertices.findIndex(vertex => !Number.isFinite(vertex?.bulge) || vertex.bulge === 0);
        if (zeroBulgeIndex < 0) return vertices;

        const startIndex = (zeroBulgeIndex + 1) % vertices.length;
        if (startIndex === 0) return vertices;
        return vertices.slice(startIndex).concat(vertices.slice(0, startIndex));
      }

      function approxAciFromHex(hex) {
        const mapping = {
          '#FF4444': 1,
          '#FFFF44': 2,
          '#44DD44': 3,
          '#44DDDD': 4,
          '#4488FF': 5,
          '#DD44DD': 6,
          '#0000FF': 5,
          '#FFFF00': 2,
          '#CCCCCC': 7,
          '#888888': 8,
        };
        return mapping[String(hex || '').toUpperCase()] || 7;
      }

      function entityColorCodes(entity) {
        if (!entity) return null;
        const aci = [entity.colorNumber, entity.colorIndex, entity.aci]
          .find(value => Number.isFinite(value));
        if (Number.isFinite(aci) && aci !== 256 && aci !== 0) {
          return { type: 'aci', value: Math.abs(Math.trunc(aci)) };
        }
        if (typeof entity.color === 'string') {
          return { type: 'aci', value: approxAciFromHex(entity.color) };
        }
        return null;
      }

      const LINEWORK_JOIN_EPSILON = 0.001;

      function clonePoint(point) {
        return {
          x: Number(point?.x || 0),
          y: Number(point?.y || 0),
          z: Number.isFinite(point?.z) ? Number(point.z) : 0,
        };
      }

      function pointKey(point, epsilon = LINEWORK_JOIN_EPSILON) {
        const z = Number.isFinite(point?.z) ? Number(point.z) : 0;
        return [
          Math.round(Number(point?.x || 0) / epsilon),
          Math.round(Number(point?.y || 0) / epsilon),
          Math.round(z / epsilon),
        ].join(':');
      }

      function pointsAlmostEqual(a, b, epsilon = LINEWORK_JOIN_EPSILON) {
        return !!a && !!b &&
          Math.abs(Number(a.x || 0) - Number(b.x || 0)) <= epsilon &&
          Math.abs(Number(a.y || 0) - Number(b.y || 0)) <= epsilon &&
          Math.abs((Number.isFinite(a.z) ? Number(a.z) : 0) - (Number.isFinite(b.z) ? Number(b.z) : 0)) <= epsilon;
      }

      function lineEndpoints(entity) {
        if (!entity || entity.type !== 'LINE') return null;
        const start = entity.start || (Array.isArray(entity.vertices) && entity.vertices.length >= 2 ? entity.vertices[0] : null);
        const end = entity.end || (Array.isArray(entity.vertices) && entity.vertices.length >= 2 ? entity.vertices[entity.vertices.length - 1] : null);
        if (!start || !end) return null;
        if (!Number.isFinite(start.x) || !Number.isFinite(start.y) || !Number.isFinite(end.x) || !Number.isFinite(end.y)) return null;
        return {
          start: clonePoint(start),
          end: clonePoint(end),
        };
      }

      function lineworkJoinSignature(entity) {
        const color = entityColorCodes(entity);
        return JSON.stringify({
          layer: entity?.layer || '0',
          colorType: color?.type || null,
          colorValue: color?.value ?? null,
        });
      }

      function orientedLineEntity(record, reverse = false) {
        if (!reverse) {
          return {
            entity: record.entity,
            start: record.start,
            end: record.end,
            startKey: record.startKey,
            endKey: record.endKey,
          };
        }
        return {
          entity: {
            ...record.entity,
            start: clonePoint(record.end),
            end: clonePoint(record.start),
          },
          start: record.end,
          end: record.start,
          startKey: record.endKey,
          endKey: record.startKey,
        };
      }

      function joinConnectedLineworkEntities(entities) {
        if (!Array.isArray(entities) || entities.length < 2) return Array.isArray(entities) ? entities : [];

        const passthrough = [];
        const groups = new Map();

        entities.forEach(entity => {
          if (entity?.type !== 'LINE') {
            passthrough.push(entity);
            return;
          }
          const endpoints = lineEndpoints(entity);
          if (!endpoints) {
            passthrough.push(entity);
            return;
          }
          const signature = lineworkJoinSignature(entity);
          const record = {
            id: `${signature}:${groups.get(signature)?.length || 0}:${entity.handle || ''}`,
            entity,
            start: endpoints.start,
            end: endpoints.end,
            startKey: pointKey(endpoints.start),
            endKey: pointKey(endpoints.end),
          };
          if (!groups.has(signature)) groups.set(signature, []);
          groups.get(signature).push(record);
        });

        const merged = [];

        groups.forEach(records => {
          if (records.length < 2) {
            merged.push(...records.map(record => record.entity));
            return;
          }

          const byId = new Map(records.map(record => [record.id, record]));
          const adjacency = new Map();
          const addAdjacency = (key, id) => {
            if (!adjacency.has(key)) adjacency.set(key, []);
            adjacency.get(key).push(id);
          };
          records.forEach(record => {
            addAdjacency(record.startKey, record.id);
            addAdjacency(record.endKey, record.id);
          });
          const degreeOf = key => adjacency.get(key)?.length || 0;
          const unused = new Set(records.map(record => record.id));

          while (unused.size) {
            const seedId = unused.values().next().value;
            const seed = byId.get(seedId);
            unused.delete(seedId);
            const chain = [orientedLineEntity(seed, false)];

            let cursorKey = seed.endKey;
            while (degreeOf(cursorKey) === 2) {
              const candidates = (adjacency.get(cursorKey) || []).filter(id => unused.has(id));
              if (candidates.length !== 1) break;
              const nextRecord = byId.get(candidates[0]);
              const reverse = nextRecord.endKey === cursorKey;
              const oriented = orientedLineEntity(nextRecord, reverse);
              chain.push(oriented);
              unused.delete(nextRecord.id);
              cursorKey = oriented.endKey;
            }

            cursorKey = seed.startKey;
            while (degreeOf(cursorKey) === 2) {
              const candidates = (adjacency.get(cursorKey) || []).filter(id => unused.has(id));
              if (candidates.length !== 1) break;
              const nextRecord = byId.get(candidates[0]);
              const reverse = nextRecord.startKey === cursorKey;
              const oriented = orientedLineEntity(nextRecord, reverse);
              chain.unshift(oriented);
              unused.delete(nextRecord.id);
              cursorKey = oriented.startKey;
            }

            if (chain.length < 2) {
              merged.push(chain[0].entity);
              continue;
            }

            const vertices = [clonePoint(chain[0].start)];
            chain.forEach(segment => vertices.push(clonePoint(segment.end)));
            const closed = pointsAlmostEqual(vertices[0], vertices[vertices.length - 1]);
            if (closed) vertices.pop();

            merged.push({
              ...chain[0].entity,
              type: 'LWPOLYLINE',
              closed,
              vertices,
            });
          }
        });

        return [...passthrough, ...merged];
      }

      function dxfEntityOptions(entity) {
        const color = entityColorCodes(entity);
        const options = { layerName: sanitizeDxfName(entity?.layer, '0') };
        if (color?.type === 'aci') options.colorNumber = color.value;
        const extrusion = entity?.extrusionDirection || null;
        if (extrusion && (Number.isFinite(extrusion.x) || Number.isFinite(extrusion.y) || Number.isFinite(extrusion.z))) {
          options.extrusion = point3d(Number(extrusion.x || 0), Number(extrusion.y || 0), Number.isFinite(extrusion.z) ? Number(extrusion.z) : 1);
        }
        return options;
      }

      function collectLayerDefs(sheetStrips) {
        const layerMap = new Map();
        const addLayer = (name, color) => {
          const layerName = sanitizeDxfName(name, '0');
          const nextColor = color || '#CCCCCC';
          const existing = layerMap.get(layerName);
          if (!existing) {
            layerMap.set(layerName, { name: layerName, color: nextColor });
            return;
          }
          if (color && existing.color !== color) {
            layerMap.set(layerName, { name: layerName, color });
          }
        };

        addLayer('0', '#CCCCCC');

        sheetStrips.forEach(strip => {
          strip.placedItems.forEach(placement => {
            const exportItem = exportItems?.[placement.item_id];
            (exportItem?.layers || []).forEach(layer => addLayer(layer.name, layer.color));
            const item = { ...globalItemsById[placement.item_id], export: exportItem };
            const engravingLayer = getEngravingLayer(item);
            if (engravingLayer) addLayer(engravingLayer.name, engravingLayer.color);
          });
        });

        return [...layerMap.values()];
      }

      function synthesizeEngravingLayer(layers, idx) {
        const sourceLayers = Array.isArray(layers) ? layers.map(layer => ({ ...layer })) : [];
        if (!Number.isFinite(idx) || idx < 1) return sourceLayers;
        if (sourceLayers[idx - 1]?.name) return sourceLayers;
        sourceLayers[idx - 1] = {
          name: `Layer ${idx}`,
          color: sourceLayers[idx - 1]?.color || FALLBACK_LAYER_COLORS[(idx - 1) % FALLBACK_LAYER_COLORS.length],
        };
        return sourceLayers.filter(Boolean);
      }

      function getEngravingLayer(item) {
        const raw = exportSettings.engravingLayer;
        if (raw === 'off' || raw == null || raw === '' || raw === false) return null;
        const idx = Number.parseInt(String(raw), 10);
        if (!Number.isFinite(idx) || idx < 1) return null;
        const layers = synthesizeEngravingLayer(item?.export?.layers || [], idx);
        return layers[idx - 1] || null;
      }

      function labelForItem(item) {
        const sourceName = item?.export?.source_name || item?.dxf || '';
        return path.basename(String(sourceName)).replace(/\.dxf$/i, '');
      }

      function bboxFromPolygon(points) {
        if (!Array.isArray(points) || !points.length) return null;
        const xs = points.map(([x]) => x);
        const ys = points.map(([, y]) => y);
        return {
          minX: Math.min(...xs),
          maxX: Math.max(...xs),
          minY: Math.min(...ys),
          maxY: Math.max(...ys),
        };
      }

      const OUTLINE_FONT = {
        '0': [
          [[0.22,0.08],[0.78,0.08],[0.92,0.22],[0.92,0.78],[0.78,0.92],[0.22,0.92],[0.08,0.78],[0.08,0.22]],
          [[0.34,0.26],[0.66,0.26],[0.74,0.34],[0.74,0.66],[0.66,0.74],[0.34,0.74],[0.26,0.66],[0.26,0.34]],
        ],
        '1': [
          [[0.24,0.26],[0.44,0.08],[0.64,0.08],[0.64,0.76],[0.78,0.76],[0.78,0.92],[0.22,0.92],[0.22,0.76],[0.46,0.76],[0.46,0.3],[0.34,0.42],[0.24,0.34]],
        ],
        '2': [
          [[0.14,0.22],[0.24,0.1],[0.76,0.1],[0.88,0.22],[0.88,0.38],[0.22,0.72],[0.22,0.78],[0.9,0.78],[0.9,0.92],[0.1,0.92],[0.1,0.7],[0.76,0.36],[0.76,0.24],[0.68,0.22],[0.24,0.22]],
        ],
        '3': [
          [[0.12,0.2],[0.24,0.1],[0.74,0.1],[0.88,0.22],[0.88,0.4],[0.74,0.5],[0.88,0.6],[0.88,0.78],[0.74,0.9],[0.24,0.9],[0.12,0.8],[0.28,0.7],[0.68,0.7],[0.74,0.64],[0.74,0.56],[0.66,0.5],[0.36,0.5],[0.36,0.36],[0.66,0.36],[0.74,0.3],[0.74,0.22],[0.68,0.2],[0.28,0.2]],
        ],
        '4': [
          [[0.58,0.1],[0.78,0.1],[0.78,0.9],[0.58,0.9]],
          [[0.14,0.46],[0.62,0.46],[0.62,0.62],[0.14,0.62]],
          [[0.14,0.46],[0.52,0.1],[0.7,0.1],[0.32,0.46]],
        ],
        '5': [
          [[0.14,0.1],[0.88,0.1],[0.88,0.24],[0.3,0.24],[0.3,0.42],[0.74,0.42],[0.88,0.56],[0.88,0.78],[0.74,0.92],[0.24,0.92],[0.12,0.82],[0.26,0.7],[0.68,0.7],[0.74,0.64],[0.74,0.58],[0.68,0.54],[0.14,0.54]],
        ],
        '6': [
          [[0.82,0.18],[0.7,0.08],[0.3,0.08],[0.14,0.22],[0.14,0.78],[0.28,0.92],[0.74,0.92],[0.88,0.78],[0.88,0.58],[0.74,0.44],[0.36,0.44],[0.3,0.38],[0.3,0.28],[0.36,0.22],[0.68,0.22],[0.74,0.28]],
          [[0.34,0.56],[0.68,0.56],[0.74,0.62],[0.74,0.74],[0.68,0.8],[0.34,0.8],[0.28,0.74],[0.28,0.62]],
        ],
        '7': [
          [[0.1,0.1],[0.9,0.1],[0.9,0.24],[0.48,0.92],[0.26,0.92],[0.66,0.24],[0.1,0.24]],
        ],
        '8': [
          [[0.24,0.08],[0.76,0.08],[0.88,0.2],[0.88,0.36],[0.76,0.48],[0.88,0.6],[0.88,0.8],[0.76,0.92],[0.24,0.92],[0.12,0.8],[0.12,0.6],[0.24,0.48],[0.12,0.36],[0.12,0.2]],
          [[0.3,0.22],[0.68,0.22],[0.74,0.28],[0.74,0.34],[0.68,0.4],[0.3,0.4],[0.26,0.34],[0.26,0.28]],
          [[0.3,0.56],[0.68,0.56],[0.74,0.62],[0.74,0.72],[0.68,0.78],[0.3,0.78],[0.26,0.72],[0.26,0.62]],
        ],
        '9': [
          [[0.24,0.08],[0.74,0.08],[0.88,0.22],[0.88,0.78],[0.72,0.92],[0.34,0.92],[0.2,0.82],[0.3,0.7],[0.68,0.7],[0.74,0.64],[0.74,0.52],[0.68,0.46],[0.24,0.46],[0.1,0.32],[0.1,0.22]],
          [[0.3,0.22],[0.66,0.22],[0.74,0.3],[0.74,0.38],[0.68,0.46],[0.32,0.46],[0.26,0.4],[0.26,0.28]],
        ],
        'A': [
          [[0.08,0.92],[0.38,0.08],[0.62,0.08],[0.92,0.92],[0.72,0.92],[0.64,0.68],[0.36,0.68],[0.28,0.92]],
          [[0.42,0.5],[0.58,0.5],[0.5,0.26]],
        ],
        'B': [
          [[0.12,0.08],[0.64,0.08],[0.82,0.2],[0.82,0.38],[0.68,0.5],[0.82,0.62],[0.82,0.8],[0.64,0.92],[0.12,0.92]],
          [[0.28,0.24],[0.58,0.24],[0.66,0.3],[0.66,0.4],[0.58,0.46],[0.28,0.46]],
          [[0.28,0.56],[0.58,0.56],[0.66,0.62],[0.66,0.74],[0.58,0.78],[0.28,0.78]],
        ],
        'C': [
          [[0.88,0.2],[0.74,0.08],[0.24,0.08],[0.08,0.24],[0.08,0.76],[0.24,0.92],[0.74,0.92],[0.88,0.8],[0.74,0.68],[0.64,0.76],[0.32,0.76],[0.24,0.68],[0.24,0.32],[0.32,0.24],[0.64,0.24],[0.74,0.32]],
        ],
        'D': [
          [[0.12,0.08],[0.56,0.08],[0.82,0.24],[0.82,0.76],[0.56,0.92],[0.12,0.92]],
          [[0.28,0.24],[0.5,0.24],[0.66,0.34],[0.66,0.66],[0.5,0.76],[0.28,0.76]],
        ],
        'E': [
          [[0.12,0.08],[0.88,0.08],[0.88,0.24],[0.28,0.24],[0.28,0.42],[0.72,0.42],[0.72,0.58],[0.28,0.58],[0.28,0.76],[0.88,0.76],[0.88,0.92],[0.12,0.92]],
        ],
        'F': [
          [[0.12,0.08],[0.88,0.08],[0.88,0.24],[0.28,0.24],[0.28,0.42],[0.72,0.42],[0.72,0.58],[0.28,0.58],[0.28,0.92],[0.12,0.92]],
        ],
        'G': [
          [[0.88,0.2],[0.74,0.08],[0.24,0.08],[0.08,0.24],[0.08,0.76],[0.24,0.92],[0.74,0.92],[0.88,0.78],[0.88,0.56],[0.56,0.56],[0.56,0.7],[0.72,0.7],[0.72,0.68],[0.64,0.76],[0.32,0.76],[0.24,0.68],[0.24,0.32],[0.32,0.24],[0.64,0.24],[0.74,0.32]],
        ],
        'H': [
          [[0.12,0.08],[0.28,0.08],[0.28,0.42],[0.72,0.42],[0.72,0.08],[0.88,0.08],[0.88,0.92],[0.72,0.92],[0.72,0.58],[0.28,0.58],[0.28,0.92],[0.12,0.92]],
        ],
        'I': [
          [[0.16,0.08],[0.84,0.08],[0.84,0.22],[0.58,0.22],[0.58,0.78],[0.84,0.78],[0.84,0.92],[0.16,0.92],[0.16,0.78],[0.42,0.78],[0.42,0.22],[0.16,0.22]],
        ],
        'J': [
          [[0.18,0.72],[0.34,0.72],[0.34,0.76],[0.42,0.84],[0.64,0.84],[0.72,0.76],[0.72,0.08],[0.88,0.08],[0.88,0.8],[0.7,0.92],[0.36,0.92],[0.18,0.8]],
        ],
        'K': [
          [[0.12,0.08],[0.28,0.08],[0.28,0.42],[0.72,0.08],[0.92,0.08],[0.5,0.42],[0.94,0.92],[0.74,0.92],[0.28,0.48],[0.28,0.92],[0.12,0.92]],
        ],
        'L': [
          [[0.12,0.08],[0.28,0.08],[0.28,0.76],[0.88,0.76],[0.88,0.92],[0.12,0.92]],
        ],
        'M': [
          [[0.08,0.92],[0.08,0.08],[0.28,0.08],[0.5,0.46],[0.72,0.08],[0.92,0.08],[0.92,0.92],[0.76,0.92],[0.76,0.34],[0.58,0.64],[0.42,0.64],[0.24,0.34],[0.24,0.92]],
        ],
        'N': [
          [[0.12,0.92],[0.12,0.08],[0.3,0.08],[0.72,0.66],[0.72,0.08],[0.88,0.08],[0.88,0.92],[0.72,0.92],[0.28,0.32],[0.28,0.92]],
        ],
        'O': [
          [[0.24,0.08],[0.76,0.08],[0.92,0.24],[0.92,0.76],[0.76,0.92],[0.24,0.92],[0.08,0.76],[0.08,0.24]],
          [[0.34,0.24],[0.66,0.24],[0.76,0.34],[0.76,0.66],[0.66,0.76],[0.34,0.76],[0.24,0.66],[0.24,0.34]],
        ],
        'P': [
          [[0.12,0.92],[0.12,0.08],[0.66,0.08],[0.84,0.22],[0.84,0.42],[0.66,0.56],[0.28,0.56],[0.28,0.92]],
          [[0.36,0.22],[0.58,0.22],[0.68,0.3],[0.68,0.4],[0.6,0.44],[0.36,0.44],[0.28,0.38],[0.28,0.28]],
        ],
        'Q': [
          [[0.24,0.08],[0.76,0.08],[0.92,0.24],[0.92,0.76],[0.76,0.92],[0.24,0.92],[0.08,0.76],[0.08,0.24]],
          [[0.34,0.24],[0.66,0.24],[0.76,0.34],[0.76,0.66],[0.66,0.76],[0.34,0.76],[0.24,0.66],[0.24,0.34]],
          [[0.58,0.64],[0.92,0.98],[0.78,1.0],[0.48,0.7]],
        ],
        'R': [
          [[0.12,0.92],[0.12,0.08],[0.64,0.08],[0.84,0.22],[0.84,0.4],[0.68,0.52],[0.48,0.52],[0.88,0.92],[0.66,0.92],[0.28,0.56],[0.28,0.92]],
          [[0.36,0.22],[0.58,0.22],[0.68,0.3],[0.68,0.4],[0.6,0.44],[0.36,0.44],[0.28,0.38],[0.28,0.28]],
        ],
        'S': [
          [[0.86,0.18],[0.72,0.08],[0.24,0.08],[0.1,0.2],[0.1,0.36],[0.24,0.48],[0.72,0.48],[0.78,0.54],[0.78,0.68],[0.7,0.76],[0.24,0.76],[0.12,0.86],[0.24,0.92],[0.76,0.92],[0.9,0.8],[0.9,0.62],[0.76,0.5],[0.28,0.5],[0.22,0.44],[0.22,0.28],[0.3,0.24],[0.74,0.24]],
        ],
        'T': [
          [[0.1,0.08],[0.9,0.08],[0.9,0.24],[0.58,0.24],[0.58,0.92],[0.42,0.92],[0.42,0.24],[0.1,0.24]],
        ],
        'U': [
          [[0.12,0.08],[0.28,0.08],[0.28,0.68],[0.34,0.76],[0.66,0.76],[0.72,0.68],[0.72,0.08],[0.88,0.08],[0.88,0.72],[0.72,0.92],[0.28,0.92],[0.12,0.72]],
        ],
        'V': [
          [[0.08,0.08],[0.28,0.08],[0.5,0.72],[0.72,0.08],[0.92,0.08],[0.6,0.92],[0.4,0.92]],
        ],
        'W': [
          [[0.08,0.08],[0.24,0.08],[0.34,0.66],[0.48,0.24],[0.62,0.66],[0.76,0.08],[0.92,0.08],[0.72,0.92],[0.56,0.92],[0.48,0.56],[0.4,0.92],[0.24,0.92]],
        ],
        'X': [
          [[0.1,0.08],[0.32,0.08],[0.5,0.36],[0.68,0.08],[0.9,0.08],[0.62,0.48],[0.92,0.92],[0.7,0.92],[0.5,0.62],[0.3,0.92],[0.08,0.92],[0.38,0.48]],
        ],
        'Y': [
          [[0.08,0.08],[0.28,0.08],[0.5,0.38],[0.72,0.08],[0.92,0.08],[0.58,0.54],[0.58,0.92],[0.42,0.92],[0.42,0.54]],
        ],
        'Z': [
          [[0.1,0.08],[0.9,0.08],[0.9,0.22],[0.34,0.78],[0.9,0.78],[0.9,0.92],[0.1,0.92],[0.1,0.78],[0.66,0.22],[0.1,0.22]],
        ],
        '-': [
          [[0.2,0.42],[0.8,0.42],[0.8,0.58],[0.2,0.58]],
        ],
        '_': [
          [[0.1,0.84],[0.9,0.84],[0.9,0.94],[0.1,0.94]],
        ],
        ' ': [],
      };

      const STROKE_FONT = {
        '0': [[[0.1,0.1],[0.9,0.1]], [[0.9,0.1],[0.9,0.9]], [[0.9,0.9],[0.1,0.9]], [[0.1,0.9],[0.1,0.1]]],
        '1': [[[0.5,0.1],[0.5,0.9]], [[0.35,0.25],[0.5,0.1]], [[0.35,0.9],[0.65,0.9]]],
        '2': [[[0.1,0.2],[0.3,0.1]], [[0.3,0.1],[0.7,0.1]], [[0.7,0.1],[0.9,0.25]], [[0.9,0.25],[0.9,0.45]], [[0.9,0.45],[0.1,0.9]], [[0.1,0.9],[0.9,0.9]]],
        '3': [[[0.1,0.1],[0.9,0.1]], [[0.9,0.1],[0.6,0.5]], [[0.6,0.5],[0.9,0.9]], [[0.1,0.9],[0.9,0.9]], [[0.3,0.5],[0.7,0.5]]],
        '4': [[[0.8,0.1],[0.8,0.9]], [[0.1,0.55],[0.9,0.55]], [[0.1,0.55],[0.65,0.1]]],
        '5': [[[0.9,0.1],[0.1,0.1]], [[0.1,0.1],[0.1,0.5]], [[0.1,0.5],[0.7,0.5]], [[0.7,0.5],[0.9,0.65]], [[0.9,0.65],[0.9,0.9]], [[0.9,0.9],[0.1,0.9]]],
        '6': [[[0.8,0.1],[0.2,0.1]], [[0.2,0.1],[0.1,0.5]], [[0.1,0.5],[0.1,0.8]], [[0.1,0.8],[0.25,0.9]], [[0.25,0.9],[0.8,0.9]], [[0.8,0.9],[0.9,0.75]], [[0.9,0.75],[0.9,0.6]], [[0.9,0.6],[0.8,0.5]], [[0.8,0.5],[0.1,0.5]]],
        '7': [[[0.1,0.1],[0.9,0.1]], [[0.9,0.1],[0.35,0.9]]],
        '8': [[[0.2,0.1],[0.8,0.1]], [[0.8,0.1],[0.9,0.25]], [[0.9,0.25],[0.9,0.4]], [[0.9,0.4],[0.8,0.5]], [[0.8,0.5],[0.9,0.6]], [[0.9,0.6],[0.9,0.8]], [[0.9,0.8],[0.8,0.9]], [[0.8,0.9],[0.2,0.9]], [[0.2,0.9],[0.1,0.8]], [[0.1,0.8],[0.1,0.6]], [[0.1,0.6],[0.2,0.5]], [[0.2,0.5],[0.1,0.4]], [[0.1,0.4],[0.1,0.25]], [[0.1,0.25],[0.2,0.1]], [[0.2,0.5],[0.8,0.5]]],
        '9': [[[0.9,0.5],[0.2,0.5]], [[0.2,0.5],[0.1,0.4]], [[0.1,0.4],[0.1,0.2]], [[0.1,0.2],[0.2,0.1]], [[0.2,0.1],[0.8,0.1]], [[0.8,0.1],[0.9,0.2]], [[0.9,0.2],[0.9,0.9]], [[0.9,0.9],[0.2,0.9]]],
        'A': [[[0.1,0.9],[0.5,0.1]], [[0.5,0.1],[0.9,0.9]], [[0.25,0.6],[0.75,0.6]]],
        'B': [[[0.1,0.1],[0.1,0.9]], [[0.1,0.1],[0.75,0.1]], [[0.75,0.1],[0.9,0.25]], [[0.9,0.25],[0.9,0.4]], [[0.9,0.4],[0.75,0.5]], [[0.75,0.5],[0.1,0.5]], [[0.75,0.5],[0.9,0.6]], [[0.9,0.6],[0.9,0.8]], [[0.9,0.8],[0.75,0.9]], [[0.75,0.9],[0.1,0.9]]],
        'C': [[[0.9,0.2],[0.75,0.1]], [[0.75,0.1],[0.2,0.1]], [[0.2,0.1],[0.1,0.25]], [[0.1,0.25],[0.1,0.75]], [[0.1,0.75],[0.2,0.9]], [[0.2,0.9],[0.75,0.9]], [[0.75,0.9],[0.9,0.8]]],
        'D': [[[0.1,0.1],[0.1,0.9]], [[0.1,0.1],[0.7,0.1]], [[0.7,0.1],[0.9,0.3]], [[0.9,0.3],[0.9,0.7]], [[0.9,0.7],[0.7,0.9]], [[0.7,0.9],[0.1,0.9]]],
        'E': [[[0.9,0.1],[0.1,0.1]], [[0.1,0.1],[0.1,0.9]], [[0.1,0.5],[0.7,0.5]], [[0.1,0.9],[0.9,0.9]]],
        'F': [[[0.1,0.1],[0.1,0.9]], [[0.1,0.1],[0.9,0.1]], [[0.1,0.5],[0.7,0.5]]],
        'G': [[[0.9,0.25],[0.75,0.1]], [[0.75,0.1],[0.2,0.1]], [[0.2,0.1],[0.1,0.25]], [[0.1,0.25],[0.1,0.75]], [[0.1,0.75],[0.2,0.9]], [[0.2,0.9],[0.75,0.9]], [[0.75,0.9],[0.9,0.75]], [[0.9,0.75],[0.9,0.55]], [[0.9,0.55],[0.55,0.55]]],
        'H': [[[0.1,0.1],[0.1,0.9]], [[0.9,0.1],[0.9,0.9]], [[0.1,0.5],[0.9,0.5]]],
        'I': [[[0.2,0.1],[0.8,0.1]], [[0.5,0.1],[0.5,0.9]], [[0.2,0.9],[0.8,0.9]]],
        'J': [[[0.8,0.1],[0.8,0.8]], [[0.8,0.8],[0.65,0.9]], [[0.65,0.9],[0.3,0.9]], [[0.3,0.9],[0.15,0.75]]],
        'K': [[[0.1,0.1],[0.1,0.9]], [[0.9,0.1],[0.1,0.55]], [[0.35,0.45],[0.9,0.9]]],
        'L': [[[0.1,0.1],[0.1,0.9]], [[0.1,0.9],[0.9,0.9]]],
        'M': [[[0.1,0.9],[0.1,0.1]], [[0.1,0.1],[0.5,0.5]], [[0.5,0.5],[0.9,0.1]], [[0.9,0.1],[0.9,0.9]]],
        'N': [[[0.1,0.9],[0.1,0.1]], [[0.1,0.1],[0.9,0.9]], [[0.9,0.9],[0.9,0.1]]],
        'O': [[[0.2,0.1],[0.8,0.1]], [[0.8,0.1],[0.9,0.25]], [[0.9,0.25],[0.9,0.75]], [[0.9,0.75],[0.8,0.9]], [[0.8,0.9],[0.2,0.9]], [[0.2,0.9],[0.1,0.75]], [[0.1,0.75],[0.1,0.25]], [[0.1,0.25],[0.2,0.1]]],
        'P': [[[0.1,0.9],[0.1,0.1]], [[0.1,0.1],[0.8,0.1]], [[0.8,0.1],[0.9,0.25]], [[0.9,0.25],[0.9,0.4]], [[0.9,0.4],[0.8,0.5]], [[0.8,0.5],[0.1,0.5]]],
        'Q': [[[0.2,0.1],[0.8,0.1]], [[0.8,0.1],[0.9,0.25]], [[0.9,0.25],[0.9,0.75]], [[0.9,0.75],[0.8,0.9]], [[0.8,0.9],[0.2,0.9]], [[0.2,0.9],[0.1,0.75]], [[0.1,0.75],[0.1,0.25]], [[0.1,0.25],[0.2,0.1]], [[0.55,0.65],[0.9,1.0]]],
        'R': [[[0.1,0.9],[0.1,0.1]], [[0.1,0.1],[0.8,0.1]], [[0.8,0.1],[0.9,0.25]], [[0.9,0.25],[0.9,0.4]], [[0.9,0.4],[0.8,0.5]], [[0.8,0.5],[0.1,0.5]], [[0.45,0.5],[0.9,0.9]]],
        'S': [[[0.9,0.15],[0.75,0.1]], [[0.75,0.1],[0.2,0.1]], [[0.2,0.1],[0.1,0.25]], [[0.1,0.25],[0.1,0.4]], [[0.1,0.4],[0.2,0.5]], [[0.2,0.5],[0.8,0.5]], [[0.8,0.5],[0.9,0.6]], [[0.9,0.6],[0.9,0.8]], [[0.9,0.8],[0.8,0.9]], [[0.8,0.9],[0.2,0.9]], [[0.2,0.9],[0.1,0.85]]],
        'T': [[[0.1,0.1],[0.9,0.1]], [[0.5,0.1],[0.5,0.9]]],
        'U': [[[0.1,0.1],[0.1,0.75]], [[0.1,0.75],[0.2,0.9]], [[0.2,0.9],[0.8,0.9]], [[0.8,0.9],[0.9,0.75]], [[0.9,0.75],[0.9,0.1]]],
        'V': [[[0.1,0.1],[0.5,0.9]], [[0.5,0.9],[0.9,0.1]]],
        'W': [[[0.1,0.1],[0.25,0.9]], [[0.25,0.9],[0.5,0.45]], [[0.5,0.45],[0.75,0.9]], [[0.75,0.9],[0.9,0.1]]],
        'X': [[[0.1,0.1],[0.9,0.9]], [[0.9,0.1],[0.1,0.9]]],
        'Y': [[[0.1,0.1],[0.5,0.5]], [[0.9,0.1],[0.5,0.5]], [[0.5,0.5],[0.5,0.9]]],
        'Z': [[[0.1,0.1],[0.9,0.1]], [[0.9,0.1],[0.1,0.9]], [[0.1,0.9],[0.9,0.9]]],
        '-': [[[0.2,0.5],[0.8,0.5]]],
        '_': [[[0.1,0.9],[0.9,0.9]]],
        ' ': [],
      };

      function buildStrokeLabelEntities(text, layerName, placedPolygon, placedHoles = []) {
        // Apply the style-driven text transform before layout so the
        // engraving sizing reflects the actual rendered characters even when
        // the user chose one of the first/last-N-character modes.
        const engravedText = engravingLabelText(text, exportSettings.engravingStyle);
        if (!engravedText) return [];
        const layout = layoutEngravingLabel({
          text: engravedText,
          outerPolygon: placedPolygon,
          holes: placedHoles,
        });
        if (!layout) return [];

        const { chars, charH, charW, startX, baseY } = layout;
        const entities = [];
        // Content-truncating modes affect what text is engraved, not how each
        // glyph is drawn — they all render as simple single-line strokes.
        const style = engravingVisualStyle(exportSettings.engravingStyle);
        const glyphPoint = (point, ox) => ({
          x: +(ox + point[0] * charW).toFixed(4),
          y: +(baseY + (1 - point[1]) * charH).toFixed(4),
          z: 0,
        });

        const pushLoop = (loop, ox) => {
          if (!Array.isArray(loop) || loop.length < 2) return;
          for (let i = 0; i < loop.length; i++) {
            const a = loop[i];
            const b = loop[(i + 1) % loop.length];
            entities.push({
              type: 'LINE',
              layer: layerName,
              start: glyphPoint(a, ox),
              end: glyphPoint(b, ox),
            });
          }
        };

        chars.forEach((ch, idx) => {
          const ox = startX + idx * charW * ENGRAVING_LAYOUT_DEFAULTS.charAdvance;
          const loops = style === 'stroked' ? OUTLINE_FONT[ch] : null;
          if (Array.isArray(loops) && loops.length) {
            loops.forEach(loop => pushLoop(loop, ox));
            return;
          }
          const strokes = STROKE_FONT[ch] || [];
          strokes.forEach(([a, b]) => {
            entities.push({
              type: 'LINE',
              layer: layerName,
              start: glyphPoint(a, ox),
              end: glyphPoint(b, ox),
            });
          });
        });

        return entities;
      }

      function addDxfEntity(dxf, entity, rotation, tx, ty, emitDebug = null) {
        if (!entity?.type) {
          if (emitDebug) emitDebug.skipped.push({ reason: 'missing-type', entity: entity || null });
          return false;
        }
        const layer = sanitizeDxfName(entity.layer, '0');

        if (entity.type === 'LINE') {
          const startPoint = entity.start || (Array.isArray(entity.vertices) && entity.vertices.length >= 2 ? entity.vertices[0] : null);
          const endPoint = entity.end || (Array.isArray(entity.vertices) && entity.vertices.length >= 2 ? entity.vertices[entity.vertices.length - 1] : null);
          if (!startPoint || !endPoint) {
            if (emitDebug) {
              emitDebug.skipped.push({
                reason: 'missing-geometry',
                type: entity.type,
                layer,
                hasStart: !!entity.start,
                hasEnd: !!entity.end,
                hasCenter: !!entity.center,
                radius: entity.radius ?? null,
                vertexCount: Array.isArray(entity.vertices) ? entity.vertices.length : 0,
                fitPointCount: Array.isArray(entity.fitPoints) ? entity.fitPoints.length : 0,
                controlPointCount: Array.isArray(entity.controlPoints) ? entity.controlPoints.length : 0,
              });
            }
            return false;
          }
          const start = transformPoint(startPoint, rotation, tx, ty);
          const end = transformPoint(endPoint, rotation, tx, ty);
          dxf.addLine(point3d(start.x, start.y, start.z || 0), point3d(end.x, end.y, end.z || 0), dxfEntityOptions(entity));
          if (emitDebug) emitDebug.emitted.LINE = (emitDebug.emitted.LINE || 0) + 1;
          return true;
        }

        if (entity.type === 'CIRCLE' && entity.center && Number.isFinite(entity.radius)) {
          const center = transformPoint(entity.center, rotation, tx, ty);
          dxf.addCircle(point3d(center.x, center.y, center.z || 0), Number(entity.radius), dxfEntityOptions(entity));
          if (emitDebug) emitDebug.emitted.CIRCLE = (emitDebug.emitted.CIRCLE || 0) + 1;
          return true;
        }

        if (entity.type === 'ARC' && entity.center && Number.isFinite(entity.radius)) {
          const center = transformPoint(entity.center, rotation, tx, ty);
          const startDeg = normalizeDegrees((Number(entity.startAngle || 0) * DEG) + rotation);
          const endDeg = normalizeDegrees((Number(entity.endAngle || 0) * DEG) + rotation);
          dxf.addArc(point3d(center.x, center.y, center.z || 0), Number(entity.radius), startDeg, endDeg, dxfEntityOptions(entity));
          if (emitDebug) emitDebug.emitted.ARC = (emitDebug.emitted.ARC || 0) + 1;
          return true;
        }

        if (entity.type === 'LWPOLYLINE' && Array.isArray(entity.vertices) && entity.vertices.length >= 2) {
          const closed = polylineClosed(entity);
          const normalizedVertices = normalizeClosedPolylineVertices(entity.vertices, closed);
          const vertices = normalizedVertices.map(vertex => {
            const point = transformPoint({
              x: vertex.x,
              y: vertex.y,
              z: Number.isFinite(vertex.z) ? vertex.z : (Number.isFinite(entity.elevation) ? entity.elevation : 0),
            }, rotation, tx, ty);
            const entry = { point: point2d(point.x, point.y) };
            if (Number.isFinite(vertex.startWidth)) entry.startingWidth = vertex.startWidth;
            if (Number.isFinite(vertex.endWidth)) entry.endWidth = vertex.endWidth;
            if (Number.isFinite(vertex.bulge)) entry.bulge = vertex.bulge;
            return entry;
          });
          const uniformWidth = Number.isFinite(entity.width) ? entity.width : 0;
          const flags = (polylineClosed(entity) ? LWPolylineFlags.Closed : LWPolylineFlags.None) |
            (entity?.hasContinuousLinetypePattern ? LWPolylineFlags.Plinegen : 0);
          const options = {
            ...dxfEntityOptions(entity),
            flags,
            constantWidth: uniformWidth,
          };
          if (Number.isFinite(entity.elevation)) options.elevation = entity.elevation;
          if (Number.isFinite(entity.depth)) options.thickness = entity.depth;
          dxf.addLWPolyline(vertices, options);
          if (emitDebug) emitDebug.emitted.LWPOLYLINE = (emitDebug.emitted.LWPOLYLINE || 0) + 1;
          return true;
        }

        if (entity.type === 'POLYLINE' && Array.isArray(entity.vertices) && entity.vertices.length >= 2) {
          const closed = polylineClosed(entity);
          const normalizedVertices = normalizeClosedPolylineVertices(entity.vertices, closed);
          if (entity.is3dPolyline) {
            const vertices = normalizedVertices.map(vertex => {
              const point = transformPoint(vertex, rotation, tx, ty);
              const entry = { point: point3d(point.x, point.y, point.z || 0) };
              if (Number.isFinite(vertex.startWidth)) entry.startingWidth = vertex.startWidth;
              if (Number.isFinite(vertex.endWidth)) entry.endWidth = vertex.endWidth;
              if (Number.isFinite(vertex.bulge)) entry.bulge = vertex.bulge;
              return entry;
            });
            dxf.addPolyline3D(vertices, {
              ...dxfEntityOptions(entity),
              flags: polylineFlags(entity) | PolylineFlags.Polyline3D,
            });
          } else {
            const vertices = normalizedVertices.map(vertex => {
              const point = transformPoint({
                x: vertex.x,
                y: vertex.y,
                z: Number.isFinite(vertex.z) ? vertex.z : (Number.isFinite(entity.elevation) ? entity.elevation : 0),
              }, rotation, tx, ty);
              const entry = { point: point2d(point.x, point.y) };
              if (Number.isFinite(vertex.startWidth)) entry.startingWidth = vertex.startWidth;
              if (Number.isFinite(vertex.endWidth)) entry.endWidth = vertex.endWidth;
              if (Number.isFinite(vertex.bulge)) entry.bulge = vertex.bulge;
              return entry;
            });
            const options = {
              ...dxfEntityOptions(entity),
              flags: (polylineClosed(entity) ? LWPolylineFlags.Closed : LWPolylineFlags.None) |
                (entity?.hasContinuousLinetypePattern ? LWPolylineFlags.Plinegen : 0),
            };
            if (Number.isFinite(entity.width)) options.constantWidth = entity.width;
            if (Number.isFinite(entity.elevation)) options.elevation = entity.elevation;
            if (Number.isFinite(entity.thickness)) options.thickness = entity.thickness;
            dxf.addLWPolyline(vertices, options);
          }
          if (emitDebug) emitDebug.emitted.POLYLINE = (emitDebug.emitted.POLYLINE || 0) + 1;
          return true;
        }

        if (entity.type === 'ELLIPSE' && entity.center && entity.majorAxisEndPoint) {
          const center = transformPoint(entity.center, rotation, tx, ty);
          const major = rotateVector(entity.majorAxisEndPoint, rotation);
          dxf.addEllipse(
            point3d(center.x, center.y, center.z || 0),
            point3d(major.x, major.y, major.z || 0),
            Number(entity.axisRatio || 1),
            Number.isFinite(entity.startParameter) ? entity.startParameter : 0,
            Number.isFinite(entity.endParameter) ? entity.endParameter : Math.PI * 2,
            dxfEntityOptions(entity)
          );
          if (emitDebug) emitDebug.emitted.ELLIPSE = (emitDebug.emitted.ELLIPSE || 0) + 1;
          return true;
        }

        if (entity.type === 'SPLINE' && (entity.controlPoints?.length || entity.fitPoints?.length)) {
          const controlPoints = (entity.controlPoints || []).map(point => {
            const transformed = transformPoint(point, rotation, tx, ty);
            return point3d(transformed.x, transformed.y, transformed.z || 0);
          });
          const fitPoints = (entity.fitPoints || []).map(point => {
            const transformed = transformPoint(point, rotation, tx, ty);
            return point3d(transformed.x, transformed.y, transformed.z || 0);
          });
          const degreeCurve = Number(entity.degreeOfSplineCurve || 3);
          if (controlPoints.length < degreeCurve + 1) {
            if (emitDebug) {
              emitDebug.skipped.push({
                reason: 'unsupported-spline',
                type: 'SPLINE',
                layer,
                controlPointCount: controlPoints.length,
                fitPointCount: fitPoints.length,
              });
            }
            return false;
          }
          const knotValues = Array.isArray(entity.knotValues)
            ? entity.knotValues
            : (Array.isArray(entity.knots) ? entity.knots : []);
          const flags =
            (entity.closed ? SplineFlags.Closed : 0) |
            (entity.periodic ? SplineFlags.Periodic : 0) |
            (entity.rational ? SplineFlags.Rational : 0) |
            (entity.planar ? SplineFlags.Planar : 0) |
            (entity.linear ? SplineFlags.Linear : 0);
          try {
            dxf.addSpline({
              controlPoints,
              fitPoints,
              degreeCurve,
              knots: knotValues,
              flags,
            }, dxfEntityOptions(entity));
          } catch {
            if (emitDebug) {
              emitDebug.skipped.push({
                reason: 'unsupported-spline',
                type: 'SPLINE',
                layer,
                controlPointCount: controlPoints.length,
                fitPointCount: fitPoints.length,
              });
            }
            return false;
          }
          if (emitDebug) emitDebug.emitted.SPLINE = (emitDebug.emitted.SPLINE || 0) + 1;
          return true;
        }

        if (emitDebug) {
          emitDebug.skipped.push({
            reason: 'missing-geometry',
            type: entity.type,
            layer,
            hasStart: !!entity.start,
            hasEnd: !!entity.end,
            hasCenter: !!entity.center,
            radius: entity.radius ?? null,
            vertexCount: Array.isArray(entity.vertices) ? entity.vertices.length : 0,
            fitPointCount: Array.isArray(entity.fitPoints) ? entity.fitPoints.length : 0,
            controlPointCount: Array.isArray(entity.controlPoints) ? entity.controlPoints.length : 0,
          });
        }
        return false;
      }

      function isRenderableExportEntity(entity) {
        return ['LINE', 'CIRCLE', 'ARC', 'LWPOLYLINE', 'POLYLINE', 'ELLIPSE', 'SPLINE'].includes(entity?.type);
      }

      // Computes a tight bounding box over all transformed geometry in the sheet.
      // Used to fill $EXTMIN/$EXTMAX in the DXF HEADER so viewers can auto-zoom to fit.
      function computeSheetBbox(sheetEntities) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        const expand = (x, y) => {
          if (!Number.isFinite(x) || !Number.isFinite(y)) return;
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        };
        const expandR = (x, y, r) => { expand(x - r, y - r); expand(x + r, y + r); };
        sheetEntities.forEach(({ entity, rotation, tx, ty }) => {
          if (!entity) return;
          if (entity.type === 'LINE') {
            const s = transformPoint(entity.start || {}, rotation, tx, ty);
            const e = transformPoint(entity.end || {}, rotation, tx, ty);
            expand(s.x, s.y); expand(e.x, e.y);
          } else if (entity.type === 'CIRCLE') {
            const c = transformPoint(entity.center || {}, rotation, tx, ty);
            expandR(c.x, c.y, Number(entity.radius) || 0);
          } else if (entity.type === 'ARC') {
            const c = transformPoint(entity.center || {}, rotation, tx, ty);
            expandR(c.x, c.y, Number(entity.radius) || 0);
          } else if (entity.type === 'LWPOLYLINE' || entity.type === 'POLYLINE') {
            (entity.vertices || []).forEach(v => {
              const p = transformPoint(v, rotation, tx, ty);
              expand(p.x, p.y);
            });
          } else if (entity.type === 'ELLIPSE' && entity.center) {
            const c = transformPoint(entity.center, rotation, tx, ty);
            const major = entity.majorAxisEndPoint;
            const r = major ? Math.hypot(Number(major.x) || 0, Number(major.y) || 0) : 0;
            expandR(c.x, c.y, r);
          } else if (entity.type === 'SPLINE') {
            [...(entity.controlPoints || []), ...(entity.fitPoints || [])].forEach(pt => {
              const p = transformPoint(pt, rotation, tx, ty);
              expand(p.x, p.y);
            });
          }
        });
        return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
      }

      function buildDXF(sheetEntities, engravings, layerDefs, emitDebug) {
        const dxf = new DxfWriter();
        dxf.setUnits(Units.Millimeters);

        const bbox = computeSheetBbox(sheetEntities);
        const bMinX = bbox ? +bbox.minX.toFixed(4) : 0;
        const bMinY = bbox ? +bbox.minY.toFixed(4) : 0;
        const bMaxX = bbox ? +bbox.maxX.toFixed(4) : 0;
        const bMaxY = bbox ? +bbox.maxY.toFixed(4) : 0;

        dxf.setVariable('$EXTMIN', { 10: bMinX, 20: bMinY, 30: 0 });
        dxf.setVariable('$EXTMAX', { 10: bMaxX, 20: bMaxY, 30: 0 });
        dxf.setVariable('$LIMMIN', { 10: 0, 20: 0 });
        dxf.setVariable('$LIMMAX', { 10: Math.ceil(bMaxX), 20: Math.ceil(bMaxY) });
        dxf.setVariable('$LTSCALE', { 40: 1.0 });
        dxf.setCurrentLayerName('0');

        layerDefs.forEach(layer => {
          if (layer.name === '0') return;
          try {
            dxf.addLayer(layer.name, approxAciFromHex(layer.color), 'Continuous');
          } catch {
            // Defensive only: collectLayerDefs already de-duplicates sanitized names.
          }
        });

        sheetEntities.forEach(entity => addDxfEntity(dxf, entity.entity, entity.rotation, entity.tx, entity.ty, emitDebug));
        engravings.forEach(engraving => {
          if (engraving.engravingLayer && engraving.placedPolygon?.length) {
            const labelEntities = buildStrokeLabelEntities(
              engraving.label,
              engraving.engravingLayer,
              engraving.placedPolygon,
              engraving.placedHoles || [],
            );
            labelEntities.forEach(entity => {
              addDxfEntity(dxf, entity, 0, 0, 0, emitDebug);
            });
          }
        });

        return dxf.stringify();
      }

      let fileCount = 0;

      for (let exportIndex = 0; exportIndex < strips.length; exportIndex++) {
        const strip = strips[exportIndex];
        if (!strip.json_path || !fs.existsSync(strip.json_path)) continue;

        let stripData;
        try {
          stripData = JSON.parse(fs.readFileSync(strip.json_path, 'utf-8'));
        } catch (e) {
          continue;
        }

        const placedItems = stripData.solution?.layout?.placed_items || [];
        const sheetEntities = [];
        const engravings = [];
        const debugRows = [];
        const emitDebug = { emitted: {}, skipped: [] };

        placedItems.forEach(placement => {
          const exportItem = exportItems?.[placement.item_id] || null;
          const item = {
            ...globalItemsById[placement.item_id],
            export: exportItem,
          };
          if (!item?.shape?.data) return;
          const { rotation, translation: [tx, ty] } = placement.transformation;
          const sourcePolygon = item.export?.polygon || item.shape.data;
          const transformed = applyTransform(sourcePolygon, rotation, tx, ty);
          const pts = transformed[0] && transformed[transformed.length - 1] &&
            Math.abs(transformed[0][0] - transformed[transformed.length - 1][0]) < 0.01 &&
            Math.abs(transformed[0][1] - transformed[transformed.length - 1][1]) < 0.01
            ? transformed.slice(0, -1) : transformed;
          const placedHoles = Array.isArray(item.export?.holes)
            ? item.export.holes
              .map(hole => applyTransform(hole, rotation, tx, ty)
                .map(([x, y]) => ({ x, y })))
              .filter(hole => hole.length >= 3)
            : [];
          engravings.push({
            rotation,
            placedPolygon: pts,
            placedHoles,
            engravingLayer: getEngravingLayer(item)?.name || null,
            label: labelForItem(item),
          });
          const rawEntities = (item.export?.entities || []).filter(isRenderableExportEntity);
          const entities = exportSettings.joinConnectedLinework
            ? joinConnectedLineworkEntities(rawEntities)
            : rawEntities;
          let usedFallback = false;
          if (entities.length) {
            entities.forEach(entity => {
              sheetEntities.push({
                entity,
                rotation,
                tx,
                ty,
              });
            });
          } else {
            usedFallback = true;
            sheetEntities.push({
              entity: {
                type: 'LWPOLYLINE',
                layer: '0',
                closed: true,
                vertices: pts.map(([x, y]) => ({ x, y, z: 0 })),
              },
              rotation: 0,
              tx: 0,
              ty: 0,
            });
          }

          debugRows.push({
            item_id: placement.item_id,
            has_global_item: !!globalItemsById[placement.item_id],
            has_export_item: !!exportItem,
            source_name: exportItem?.source_name || item?.dxf || null,
            export_layer_count: Array.isArray(exportItem?.layers) ? exportItem.layers.length : 0,
            export_entity_count: Array.isArray(exportItem?.entities) ? exportItem.entities.length : 0,
            joined_linework_enabled: !!exportSettings.joinConnectedLinework,
            joined_entity_count: entities.length,
            renderable_entity_count: entities.length,
            polygon_point_count: Array.isArray(sourcePolygon) ? sourcePolygon.length : 0,
            used_fallback_polygon: usedFallback,
            engraving_layer: getEngravingLayer(item)?.name || null,
            label: labelForItem(item),
            rotation,
            translation: [tx, ty],
          });
        });

        const layerDefs = collectLayerDefs([{ placedItems }]);
        const dxf = buildDXF(sheetEntities, engravings, layerDefs, emitDebug);
        const fileBase = exportSheetFileBase(strip, exportIndex);
        const outPath = path.join(outputDir, `${fileBase}.dxf`);
        const debugPath = path.join(outputDir, `${fileBase}.debug.json`);
        overwriteTextFile(outPath, dxf);
        if (exportSettings.exportDebug) {
          overwriteTextFile(debugPath, JSON.stringify({
            strip_index: strip.index,
            strip_json_path: strip.json_path,
            input_path: inputPath || null,
            sheet_width_mode: strip.sheet_width_mode || null,
            sheet_width: strip.sheet_width ?? null,
            strip_width: strip.strip_width ?? null,
            strip_height: strip.strip_height ?? null,
            export_item_key_count: Object.keys(exportItems || {}).length,
            placed_item_count: placedItems.length,
            sheet_entity_count: sheetEntities.length,
            engraving_count: engravings.length,
            emitted_entity_counts: emitDebug.emitted,
            skipped_entity_count: emitDebug.skipped.length,
            skipped_entity_samples: emitDebug.skipped.slice(0, 40),
            layer_defs: layerDefs,
            rows: debugRows,
          }, null, 2));
        } else if (fs.existsSync(debugPath)) {
          fs.rmSync(debugPath, { force: true });
        }
        fileCount++;
      }

      return { success: true, fileCount, outputDir };
      });
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
}

module.exports = {
  registerExportDxfIpc,
};
