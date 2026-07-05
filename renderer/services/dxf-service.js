'use strict';

(function defineDxfService(globalScope) {
  function createDxfService({ state, getCurrentNestingSettings }) {
    const { FALLBACK_PALETTE = [] } = globalScope.NestDxfLayerService || {};
    const {
      buildAllowedOrientations,
      sanitizePolygonPoints,
      clonePlain,
      effectiveFileQty,
      partLabelFromName,
      buildJobName,
      roundCoord,
      sameExportPoint,
    } = globalScope.NestHelpers;

    function engravingLayerIndex(settings = getCurrentNestingSettings()) {
      const raw = settings?.engravingLayer;
      if (raw === 'off' || raw === false || raw == null || raw === '') return null;
      const parsed = Number.parseInt(String(raw), 10);
      return Number.isFinite(parsed) && parsed >= 1 ? parsed : 2;
    }

    function batchLayerTemplateAtIndex(targetIndex, excludeFileId = null) {
      if (!Number.isFinite(targetIndex) || targetIndex < 1) return null;
      for (const file of state.files || []) {
        if (excludeFileId && file?.id === excludeFileId) continue;
        const layer = Array.isArray(file?.layers) ? file.layers[targetIndex - 1] : null;
        if (layer?.name || layer?.color) return { ...layer };
      }
      return null;
    }

    function synthesizeEngravingLayer(layers, settings = getCurrentNestingSettings(), excludeFileId = null) {
      const targetIndex = engravingLayerIndex(settings);
      const sourceLayers = Array.isArray(layers) ? layers.map(layer => ({ ...layer })) : [];
      if (targetIndex === null) return sourceLayers;
      if (sourceLayers[targetIndex - 1]?.name) return sourceLayers;

      const batchTemplate = batchLayerTemplateAtIndex(targetIndex, excludeFileId);
      const fallbackColor = FALLBACK_PALETTE.length
        ? FALLBACK_PALETTE[(targetIndex - 1) % FALLBACK_PALETTE.length]
        : '#4488FF';
      sourceLayers[targetIndex - 1] = {
        name: batchTemplate?.name || `Layer ${targetIndex}`,
        color: batchTemplate?.color || sourceLayers[targetIndex - 1]?.color || fallbackColor,
      };
      return sourceLayers.filter(Boolean);
    }

    // Guarantees a file has parsed shapes with export metadata before they're used.
    // If the shapes are already fully populated, skips the expensive IPC round-trip.
    async function ensureFileShapes(file) {
      const settings = getCurrentNestingSettings();
      const matchesSketchMode = file._multiSketchDetection === !!settings.multiSketchDetection;
      const sketchContourMethod = String(settings?.sketchContourMethod || 'auto');
      const matchesContourMethod = String(file?._sketchContourMethod || 'auto') === sketchContourMethod;
      const hasUsableShapes = Array.isArray(file.shapes) && file.shapes.length;
      const hasExportMetadata = hasUsableShapes && file.shapes.every(shape => Array.isArray(shape.exportEntities));
      const hasLayerTable = Array.isArray(file.layers) && file.layers.length;
      if (matchesSketchMode && matchesContourMethod && hasUsableShapes && hasExportMetadata && hasLayerTable) return file.shapes;
      if (!file.path || !window.electronAPI?.parseDXF || typeof window.parseDXFToShapes !== 'function') {
        throw new Error(`No parsed shapes available for ${file.name}`);
      }

      const result = await window.electronAPI.parseDXF(file.path, file.bookmark || null);
      if (!result?.success || !result.data) {
        throw new Error(result?.error || `Failed to parse ${file.name}`);
      }

      const parsed = window.parseDXFToShapes(result.data, result.raw, settings);
      if (!parsed?.shapes?.length) {
        throw new Error(`No nestable shapes found in ${file.name}`);
      }

      file.shapes = parsed.shapes.map(shape => ({
        ...shape,
        qty: file.qty || shape.qty || 1,
      }));
      file.layers = synthesizeEngravingLayer(parsed.layers || [], settings, file.id);
      file._multiSketchDetection = !!settings.multiSketchDetection;
      file._sketchContourMethod = sketchContourMethod;
      file.qty = effectiveFileQty(file);
      return file.shapes;
    }

    // Best-effort background parse triggered right after a file is added to the list.
    // Silently swallows errors so a parse failure doesn't break the UI or file list rendering.
    async function hydrateFileShapesForList(file, onHydrated) {
      if (!file || !file.path || (Array.isArray(file.shapes) && file.shapes.length)) return;
      if (!window.electronAPI?.parseDXF || typeof window.parseDXFToShapes !== 'function') return;

      try {
        await ensureFileShapes(file);
        if (typeof onHydrated === 'function') onHydrated(file);
      } catch (error) {
        console.warn(`[DXF] Failed to pre-parse ${file.name}:`, error.message);
      }
    }
    function stripClosingPoint(points) {
      if (!Array.isArray(points) || points.length < 2) return Array.isArray(points) ? [...points] : [];
      return sameExportPoint(points[0], points[points.length - 1]) ? points.slice(0, -1) : [...points];
    }

    function isCollinearPoint(prev, point, next) {
      if (!prev || !point || !next) return false;
      const abx = point.x - prev.x;
      const aby = point.y - prev.y;
      const bcx = next.x - point.x;
      const bcy = next.y - point.y;
      const cross = roundCoord(abx * bcy - aby * bcx);
      if (Math.abs(cross) > 1e-4) return false;
      const dot = (point.x - prev.x) * (point.x - next.x) + (point.y - prev.y) * (point.y - next.y);
      return dot <= 1e-8;
    }

    function dropCollinearPoints(points) {
      if (!Array.isArray(points) || points.length < 4) return Array.isArray(points) ? [...points] : [];
      const filtered = points.filter((point, index, all) => !isCollinearPoint(
        all[(index - 1 + all.length) % all.length],
        point,
        all[(index + 1) % all.length]
      ));
      return filtered.length >= 3 ? filtered : points;
    }

    function cleanSolverRing(points) {
      const sanitized = sanitizePolygonPoints(points);
      if (sanitized.length < 3) return [];
      const openRing = stripClosingPoint(sanitized);
      if (openRing.length < 3) return [];
      return dropCollinearPoints(openRing);
    }

    function normalizeSolverRing(points, origin) {
      return points.map(point => ({
        x: roundCoord(point.x - origin.x),
        y: roundCoord(point.y - origin.y),
      }));
    }
    function normalizeExportPoint(point, origin) {
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return point;
      return {
        ...point,
        x: roundCoord(point.x - origin.x),
        y: roundCoord(point.y - origin.y),
      };
    }

    function normalizeExportEntity(entity, origin) {
      if (!entity || !origin) return entity;
      return {
        ...entity,
        start: normalizeExportPoint(entity.start, origin),
        end: normalizeExportPoint(entity.end, origin),
        center: normalizeExportPoint(entity.center, origin),
        vertices: Array.isArray(entity.vertices)
          ? entity.vertices.map(vertex => normalizeExportPoint(vertex, origin))
          : entity.vertices,
        fitPoints: Array.isArray(entity.fitPoints)
          ? entity.fitPoints.map(point => normalizeExportPoint(point, origin))
          : entity.fitPoints,
        controlPoints: Array.isArray(entity.controlPoints)
          ? entity.controlPoints.map(point => normalizeExportPoint(point, origin))
          : entity.controlPoints,
      };
    }

    function buildSolverShapeGeometry(shape) {
      const outer = cleanSolverRing(shape?.polygonPoints);
      if (outer.length < 3) return null;
      const origin = outer.reduce((acc, point) => ({
        x: Math.min(acc.x, point.x),
        y: Math.min(acc.y, point.y),
      }), { x: outer[0].x, y: outer[0].y });
      return {
        origin,
        outer: normalizeSolverRing(outer, origin),
        holes: (shape?.holes || [])
          .map(hole => cleanSolverRing(hole?.points || []))
          .filter(hole => hole.length >= 3)
          .map(hole => normalizeSolverRing(hole, origin)),
      };
    }

    // Assembles the full JSON payload the Sparrow solver expects.
    // Iterates all files, sanitises polygon points, assigns integer IDs, and builds
    // the exportItems side-table so the export pipeline can look up layer/entity data by ID.
    async function buildPlacementPayload() {
      const items = [];
      const exportItems = {};
      let nextId = 0;
      const settings = getCurrentNestingSettings();
      const allowedOrientations = buildAllowedOrientations(settings.rotationStep);

      for (const file of state.files) {
        await ensureFileShapes(file);
        file.layers = synthesizeEngravingLayer(file.layers || [], settings, file.id);
      }

      for (const file of state.files) {
        const shapes = (await ensureFileShapes(file)).filter(shape => shape.visible !== false);
        shapes.forEach(shape => {
          const geometry = buildSolverShapeGeometry(shape);
          if (!geometry?.outer?.length) return;
          const itemId = nextId++;

          items.push({
            id: itemId,
            demand: Math.max(1, parseInt(shape.qty || 1, 10)),
            dxf: file.path || file.name,
            allowed_orientations: [...allowedOrientations],
            shape: {
              type: 'simple_polygon',
              data: geometry.outer.map(point => [point.x, point.y]),
            },
          });

          exportItems[itemId] = {
            source_file: file.path || file.name,
            source_name: file.name,
            source_shape_id: shape.id,
            part_label: partLabelFromName(file.name),
            layers: clonePlain(synthesizeEngravingLayer(file.layers || [], settings, file.id)),
            entities: clonePlain((shape.exportEntities || []).map(entity => normalizeExportEntity(entity, geometry.origin))),
            polygon: geometry.outer.map(point => [point.x, point.y]),
            holes: clonePlain(geometry.holes.map(hole => hole.map(point => [point.x, point.y]))),
          };
        });
      }

      if (!items.length) {
        throw new Error('No exportable shapes available');
      }

      state.lastPlacementExportItems = exportItems;

      return {
        name: buildJobName(state.files),
        settings,
        items,
        sheets: state.sheets.map(sheet => ({
          id: sheet.id,
          width: sheet.widthMode === 'unlimited' ? null : sheet.width,
          height: sheet.height,
          width_mode: sheet.widthMode || 'fixed',
          quantity: 'auto',
          material: sheet.material || '',
        })),
        strip_height: state.sheets[0]?.height || 0,
      };
    }

    // Calls buildPlacementPayload and writes the result to disk via the Electron bridge.
    // Returns the file path so the nesting service can log it and pass it to Sparrow.
    async function exportPlacementJSON() {
      const payload = await buildPlacementPayload();
      if (!window.electronAPI?.savePlacementJSON) {
        throw new Error('Placement JSON export is not available');
      }

      const result = await window.electronAPI.savePlacementJSON(payload);
      if (!result?.success) {
        throw new Error(result?.error || 'Failed to save placement JSON');
      }

      state.lastExportPath = result.path;
      return { payload, path: result.path, directory: result.directory };
    }

    return {
      ensureFileShapes,
      hydrateFileShapesForList,
      buildPlacementPayload,
      exportPlacementJSON,
    };
  }

  globalScope.NestDxfService = { createDxfService };
})(window);
