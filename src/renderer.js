import { GEOMETRY_CONFIG, SCORE_PALETTE } from "./config.js";
import {
  TAU,
  angleColumnToTurns,
  createDiscGeometry,
  radialRowToRadius
} from "./geometry.js";
import { getNonEmptyCellIndices } from "./score.js";

const MAX_DIRTY_LAYER_CELL_UPDATES = 160000;
const TURNTABLE_MARKER_ALPHA = 0.2;
const TURNTABLE_MARKER_HEIGHT_RATIO = 0.13;
const TURNTABLE_MARKER_WIDTH_TO_HEIGHT = 11 / 14;
const TURNTABLE_MARKER_COUNT = 3;
const TURNTABLE_MARKER_GUIDE_STROKE_WIDTH = 1.5;
const TURNTABLE_MARKER_GUIDE_HALF_STROKE_WIDTH =
  TURNTABLE_MARKER_GUIDE_STROKE_WIDTH / 2;
const TURNTABLE_MARKER_GROUP_ROTATIONS = Object.freeze([0, -0.25, 0.5, 0.25]);
const TURNTABLE_MARKER_GUIDE_ROTATIONS = Object.freeze([0, 0.25, 0.5, 0.75]);

function getCanvasSize(canvas) {
  const rect =
    typeof canvas.getBoundingClientRect === "function"
      ? canvas.getBoundingClientRect()
      : { width: canvas.width, height: canvas.height };

  return {
    width: Math.max(1, rect.width || canvas.clientWidth || canvas.width || 1),
    height: Math.max(1, rect.height || canvas.clientHeight || canvas.height || 1)
  };
}

function createScoreCellPath(context, geometry, score, angleColumn, radialRow) {
  const angleCenter = angleColumnToTurns(score, angleColumn) * TAU;
  const angleHalfSpan = (0.5 / score.angleColumns) * TAU;
  const radialCenter = radialRowToRadius(geometry, score, radialRow);
  const radialStep =
    (geometry.outerRadius - geometry.innerPlayableRadius) / score.radialRows;
  const innerRadius = Math.max(
    geometry.innerPlayableRadius,
    radialCenter - radialStep * 0.52
  );
  const outerRadius = Math.min(
    geometry.outerRadius,
    radialCenter + radialStep * 0.52
  );

  context.beginPath();
  context.arc(0, 0, outerRadius, angleCenter - angleHalfSpan, angleCenter + angleHalfSpan);
  context.arc(0, 0, innerRadius, angleCenter + angleHalfSpan, angleCenter - angleHalfSpan, true);
  context.closePath();
}

function drawScoreCell(context, geometry, score, index) {
  const angleColumn = index % score.angleColumns;
  const radialRow = Math.floor(index / score.angleColumns);
  const colourIndex = score.colours[index];
  const strength = score.strengths[index];
  const paletteEntry = SCORE_PALETTE[colourIndex];

  if (!paletteEntry || strength <= 0) {
    return;
  }

  createScoreCellPath(context, geometry, score, angleColumn, radialRow);
  context.globalAlpha =
    paletteEntry.color.toLowerCase() === "#ffffff"
      ? 1
      : 0.18 + (strength / 255) * 0.72;
  context.fillStyle = paletteEntry.color;
  context.fill();
  context.globalAlpha = 1;
}

function drawScoreCellMask(context, geometry, score, angleColumn, radialRow) {
  createScoreCellPath(context, geometry, score, angleColumn, radialRow);
  context.fillStyle = "#000";
  context.fill();
}

function withScoreTransform(context, geometry, phaseTurns, draw) {
  context.save();
  context.translate(geometry.center.x, geometry.center.y);
  context.rotate((geometry.playheadAngleTurns - phaseTurns) * TAU);
  draw();
  context.restore();
}

function drawScore(context, geometry, score, phaseTurns) {
  withScoreTransform(context, geometry, phaseTurns, () => {
    for (const index of getNonEmptyCellIndices(score)) {
      drawScoreCell(context, geometry, score, index);
    }
  });
}

function geometryCacheKey(geometry, devicePixelRatio) {
  return [
    geometry.width,
    geometry.height,
    geometry.center.x,
    geometry.center.y,
    geometry.outerRadius,
    geometry.innerPlayableRadius,
    geometry.playheadAngleTurns,
    devicePixelRatio
  ].join(":");
}

function createLayerCanvas(width, height, sourceCanvas) {
  if (typeof OffscreenCanvas === "function") {
    return new OffscreenCanvas(width, height);
  }

  const ownerDocument = sourceCanvas && sourceCanvas.ownerDocument;

  if (ownerDocument && typeof ownerDocument.createElement === "function") {
    const canvas = ownerDocument.createElement("canvas");

    canvas.width = width;
    canvas.height = height;
    return canvas;
  }

  if (typeof document !== "undefined" && document.createElement) {
    const canvas = document.createElement("canvas");

    canvas.width = width;
    canvas.height = height;
    return canvas;
  }

  return null;
}

function ensureScoreLayer(renderer, geometry) {
  if (!renderer.scoreLayer.canvas) {
    renderer.scoreLayer.canvas = createLayerCanvas(
      Math.max(1, Math.round(geometry.width * renderer.devicePixelRatio)),
      Math.max(1, Math.round(geometry.height * renderer.devicePixelRatio)),
      renderer.canvas
    );
    renderer.scoreLayer.context = renderer.scoreLayer.canvas
      ? renderer.scoreLayer.canvas.getContext("2d", { alpha: true })
      : null;
  }

  if (!renderer.scoreLayer.context) {
    renderer.scoreLayer.available = false;
    renderer.scoreLayer.unavailableReason = "layer_canvas_unavailable";
    return false;
  }

  const width = Math.max(1, Math.round(geometry.width * renderer.devicePixelRatio));
  const height = Math.max(1, Math.round(geometry.height * renderer.devicePixelRatio));

  if (
    renderer.scoreLayer.canvas.width !== width ||
    renderer.scoreLayer.canvas.height !== height
  ) {
    renderer.scoreLayer.canvas.width = width;
    renderer.scoreLayer.canvas.height = height;
    renderer.scoreLayer.scoreVersion = null;
  }

  renderer.scoreLayer.available = true;
  renderer.scoreLayer.unavailableReason = null;
  return true;
}

function resetScoreLayerTransform(renderer) {
  renderer.scoreLayer.context.setTransform(
    renderer.devicePixelRatio,
    0,
    0,
    renderer.devicePixelRatio,
    0,
    0
  );
}

function clearScoreLayer(renderer, geometry) {
  resetScoreLayerTransform(renderer);
  renderer.scoreLayer.context.clearRect(0, 0, geometry.width, geometry.height);
}

function rebuildScoreLayer(renderer, geometry, score) {
  clearScoreLayer(renderer, geometry);
  withScoreTransform(renderer.scoreLayer.context, geometry, 0, () => {
    for (const index of getNonEmptyCellIndices(score)) {
      drawScoreCell(renderer.scoreLayer.context, geometry, score, index);
    }
  });
  renderer.scoreLayer.scoreVersion = score.version;
  renderer.scoreLayer.geometryKey = geometryCacheKey(
    geometry,
    renderer.devicePixelRatio
  );
  renderer.scoreLayer.renderedCellCount = score.nonEmptyIndices
    ? score.nonEmptyIndices.size
    : 0;
  renderer.stats.scoreLayerRebuilds += 1;
}

function getRegionColumnCount(score, region) {
  if (region.fullScore) {
    return score.angleColumns;
  }

  if (region.wraps) {
    return (
      score.angleColumns - region.minAngleColumn + region.maxAngleColumn + 1
    );
  }

  return region.maxAngleColumn - region.minAngleColumn + 1;
}

function estimateDirtyCellUpdates(score, dirtyRegions) {
  return dirtyRegions.reduce((total, region) => {
    if (!region) {
      return total;
    }

    const rowCount = region.fullScore
      ? score.radialRows
      : region.maxRadialRow - region.minRadialRow + 1;

    return total + getRegionColumnCount(score, region) * rowCount;
  }, 0);
}

function forEachRegionCell(score, region, visit) {
  const minRow = region.fullScore ? 0 : region.minRadialRow;
  const maxRow = region.fullScore ? score.radialRows - 1 : region.maxRadialRow;
  const visitColumnRange = (start, end) => {
    for (let angleColumn = start; angleColumn <= end; angleColumn += 1) {
      for (let radialRow = minRow; radialRow <= maxRow; radialRow += 1) {
        visit(angleColumn, radialRow);
      }
    }
  };

  if (region.fullScore) {
    visitColumnRange(0, score.angleColumns - 1);
    return;
  }

  if (region.wraps) {
    visitColumnRange(region.minAngleColumn, score.angleColumns - 1);
    visitColumnRange(0, region.maxAngleColumn);
    return;
  }

  visitColumnRange(region.minAngleColumn, region.maxAngleColumn);
}

function applyDirtyRegionsToScoreLayer(renderer, geometry, score, dirtyRegions) {
  const context = renderer.scoreLayer.context;

  resetScoreLayerTransform(renderer);
  withScoreTransform(context, geometry, 0, () => {
    context.save();
    context.globalAlpha = 1;
    context.globalCompositeOperation = "destination-out";
    for (const region of dirtyRegions) {
      forEachRegionCell(score, region, (angleColumn, radialRow) => {
        drawScoreCellMask(context, geometry, score, angleColumn, radialRow);
      });
    }
    context.restore();

    for (const region of dirtyRegions) {
      forEachRegionCell(score, region, (angleColumn, radialRow) => {
        const index = radialRow * score.angleColumns + angleColumn;

        drawScoreCell(context, geometry, score, index);
      });
    }
  });

  renderer.scoreLayer.scoreVersion = score.version;
  renderer.scoreLayer.renderedCellCount = score.nonEmptyIndices
    ? score.nonEmptyIndices.size
    : 0;
  renderer.stats.scoreLayerDirtyUpdates += 1;
}

function prepareScoreLayer(renderer, geometry, score, dirtyRegions = []) {
  if (!score || !ensureScoreLayer(renderer, geometry)) {
    return false;
  }

  const activeGeometryKey = geometryCacheKey(geometry, renderer.devicePixelRatio);
  const geometryChanged = renderer.scoreLayer.geometryKey !== activeGeometryKey;

  if (geometryChanged || renderer.scoreLayer.scoreVersion === null) {
    rebuildScoreLayer(renderer, geometry, score);
    return true;
  }

  if (renderer.scoreLayer.scoreVersion === score.version) {
    return true;
  }

  const regions = Array.isArray(dirtyRegions)
    ? dirtyRegions.filter(Boolean)
    : [];
  const hasFullClear = regions.some(
    (region) => region.fullScore && region.editType === "clear"
  );
  const canUseDirtyRegions =
    regions.length > 0 &&
    regions.every(
      (region) =>
        region.fullScore ||
        (Number.isInteger(region.minAngleColumn) &&
          Number.isInteger(region.maxAngleColumn) &&
          Number.isInteger(region.minRadialRow) &&
          Number.isInteger(region.maxRadialRow))
    );

  if (hasFullClear && (!score.nonEmptyIndices || score.nonEmptyIndices.size === 0)) {
    clearScoreLayer(renderer, geometry);
    renderer.scoreLayer.scoreVersion = score.version;
    renderer.scoreLayer.geometryKey = activeGeometryKey;
    renderer.scoreLayer.renderedCellCount = 0;
    renderer.stats.scoreLayerClears += 1;
    return true;
  }

  if (
    canUseDirtyRegions &&
    estimateDirtyCellUpdates(score, regions) <= MAX_DIRTY_LAYER_CELL_UPDATES
  ) {
    applyDirtyRegionsToScoreLayer(renderer, geometry, score, regions);
    renderer.scoreLayer.geometryKey = activeGeometryKey;
    return true;
  }

  rebuildScoreLayer(renderer, geometry, score);
  return true;
}

function drawScoreLayer(renderer, geometry, transport) {
  const context = renderer.context;
  const layer = renderer.scoreLayer.canvas;

  context.save();
  context.translate(geometry.center.x, geometry.center.y);
  context.rotate(-transport.phaseTurns * TAU);
  context.drawImage(
    layer,
    0,
    0,
    layer.width,
    layer.height,
    -geometry.center.x,
    -geometry.center.y,
    geometry.width,
    geometry.height
  );
  context.restore();
  renderer.stats.scoreLayerFrameDraws += 1;
}

function drawTurntableMarkerTriangle(context, centerY, width, height) {
  const offsetX = TURNTABLE_MARKER_GUIDE_HALF_STROKE_WIDTH;

  context.beginPath();
  context.moveTo(offsetX, centerY - height / 2);
  context.lineTo(offsetX, centerY + height / 2);
  context.lineTo(offsetX + width, centerY);
  context.closePath();
  context.fill();
}

function getTurntableMarkerCenterYs(geometry) {
  const spacing =
    (geometry.outerRadius - geometry.innerPlayableRadius) /
    (TURNTABLE_MARKER_COUNT + 1);

  return Array.from({ length: TURNTABLE_MARKER_COUNT }, (_, index) => {
    const radius = geometry.outerRadius - spacing * (index + 1);

    return radius;
  });
}

function drawTurntableMarkerGuideLines(context, geometry) {
  context.lineWidth = TURNTABLE_MARKER_GUIDE_STROKE_WIDTH;
  context.strokeStyle = "#000000";

  for (const rotationTurns of TURNTABLE_MARKER_GUIDE_ROTATIONS) {
    context.save();
    context.rotate(rotationTurns * TAU);

    context.beginPath();
    context.moveTo(0, geometry.innerPlayableRadius);
    context.lineTo(0, geometry.outerRadius);
    context.stroke();

    context.restore();
  }
}

function drawTurntableMarkers(context, geometry, transport) {
  const previousAlpha = context.globalAlpha;
  const previousFillStyle = context.fillStyle;
  const previousLineWidth = context.lineWidth;
  const previousStrokeStyle = context.strokeStyle;
  const height = geometry.outerRadius * TURNTABLE_MARKER_HEIGHT_RATIO;
  const width = height * TURNTABLE_MARKER_WIDTH_TO_HEIGHT;

  context.save();
  context.translate(geometry.center.x, geometry.center.y);
  context.rotate(-(transport.phaseTurns || 0) * TAU);
  context.globalAlpha = TURNTABLE_MARKER_ALPHA;
  context.fillStyle = "#000000";
  drawTurntableMarkerGuideLines(context, geometry);

  for (const rotationTurns of TURNTABLE_MARKER_GROUP_ROTATIONS) {
    context.save();
    context.rotate(rotationTurns * TAU);

    for (const centerY of getTurntableMarkerCenterYs(geometry)) {
      drawTurntableMarkerTriangle(context, centerY, width, height);
    }

    context.restore();
  }

  context.globalAlpha = previousAlpha;
  context.fillStyle = previousFillStyle;
  context.lineWidth = previousLineWidth;
  context.strokeStyle = previousStrokeStyle;
  context.restore();
}

export function createRenderer(canvas, config = GEOMETRY_CONFIG) {
  const context =
    canvas && typeof canvas.getContext === "function"
      ? canvas.getContext("2d", { alpha: true })
      : null;

  const renderer = {
    status: context ? "score_driven_canvas_disc" : "canvas_unavailable",
    drawsFromScore: Boolean(context),
    readsCanvasPixels: false,
    canvas,
    context,
    config,
    devicePixelRatio: 1,
    geometry: null,
    scoreLayer: {
      available: false,
      unavailableReason: null,
      canvas: null,
      context: null,
      scoreVersion: null,
      geometryKey: null,
      renderedCellCount: 0
    },
    stats: {
      scoreLayerRebuilds: 0,
      scoreLayerDirtyUpdates: 0,
      scoreLayerClears: 0,
      scoreLayerFrameDraws: 0,
      directScoreDraws: 0
    }
  };

  if (context) {
    resizeRenderer(renderer);
  }

  return renderer;
}

export function resizeRenderer(renderer) {
  if (!renderer.context || !renderer.canvas) {
    return renderer;
  }

  const size = getCanvasSize(renderer.canvas);
  const devicePixelRatio = Math.max(
    1,
    Math.min(3, globalThis.devicePixelRatio || 1)
  );
  const backingWidth = Math.round(size.width * devicePixelRatio);
  const backingHeight = Math.round(size.height * devicePixelRatio);

  if (
    renderer.canvas.width !== backingWidth ||
    renderer.canvas.height !== backingHeight
  ) {
    renderer.canvas.width = backingWidth;
    renderer.canvas.height = backingHeight;
  }

  renderer.devicePixelRatio = devicePixelRatio;
  renderer.context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  renderer.geometry = createDiscGeometry(size, renderer.config);
  renderer.scoreLayer.scoreVersion = null;

  return renderer;
}

export function renderTurntable(
  renderer,
  { score, transport, geometry, dirtyRegions = [] } = {}
) {
  if (!renderer.context || !renderer.geometry) {
    return renderer;
  }

  const context = renderer.context;
  const activeGeometry = geometry || renderer.geometry;
  const snapshot = transport || {
    phaseTurns: 0
  };

  context.clearRect(0, 0, activeGeometry.width, activeGeometry.height);

  if (score) {
    const drewLayer = prepareScoreLayer(
      renderer,
      activeGeometry,
      score,
      dirtyRegions
    );

    if (drewLayer) {
      drawScoreLayer(renderer, activeGeometry, snapshot);
    } else {
      drawScore(context, activeGeometry, score, snapshot.phaseTurns);
      renderer.stats.directScoreDraws += 1;
    }
  }

  return renderer;
}

export function createRendererPlaceholder() {
  return Object.freeze({
    status: "score_driven_canvas_disc",
    drawsFromScore: true,
    readsCanvasPixels: false
  });
}
