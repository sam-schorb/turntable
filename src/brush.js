import { BRUSH_CONFIG } from "./config.js";
import { TAU, normalizeTurns } from "./geometry.js";
import { setCellUnchecked } from "./score.js";

const stampCacheByScore = new WeakMap();
const angleCacheByColumnCount = new Map();

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function assertFiniteNumber(value, name) {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number.`);
  }
}

function validateBrushConfig(brushConfig) {
  assertFiniteNumber(brushConfig.minRadiusRatio, "minRadiusRatio");
  assertFiniteNumber(brushConfig.maxRadiusRatio, "maxRadiusRatio");
  assertFiniteNumber(
    brushConfig.speedForMaxRadiusPxPerSecond,
    "speedForMaxRadiusPxPerSecond"
  );
  assertFiniteNumber(brushConfig.smoothing, "smoothing");
}

function assertBrushScore(score) {
  if (
    !score ||
    !Number.isInteger(score.angleColumns) ||
    !Number.isInteger(score.radialRows) ||
    !Number.isInteger(score.colourCount) ||
    !(score.colours instanceof Uint8Array) ||
    !(score.strengths instanceof Uint8Array) ||
    !(score.nonEmptyIndices instanceof Set)
  ) {
    throw new TypeError("score must be a polar score created by createScore.");
  }
}

function assertColourIndex(score, colourIndex) {
  if (
    !Number.isInteger(colourIndex) ||
    colourIndex < 0 ||
    colourIndex > score.colourCount
  ) {
    throw new RangeError(
      `colourIndex must be an integer from 0 to ${score.colourCount}.`
    );
  }
}

function getAngleCache(angleColumns) {
  let angleCache = angleCacheByColumnCount.get(angleColumns);

  if (angleCache) {
    return angleCache;
  }

  const cos = new Float64Array(angleColumns);
  const sin = new Float64Array(angleColumns);

  for (let column = 0; column < angleColumns; column += 1) {
    const angleRadians = ((column + 0.5) / angleColumns) * TAU;

    cos[column] = Math.cos(angleRadians);
    sin[column] = Math.sin(angleRadians);
  }

  angleCache = Object.freeze({
    angleColumns,
    cos,
    sin
  });
  angleCacheByColumnCount.set(angleColumns, angleCache);

  return angleCache;
}

function getStampCache(score, geometry) {
  const cached = stampCacheByScore.get(score);

  if (
    cached &&
    cached.angleColumns === score.angleColumns &&
    cached.radialRows === score.radialRows &&
    cached.innerPlayableRadius === geometry.innerPlayableRadius &&
    cached.outerRadius === geometry.outerRadius
  ) {
    return cached;
  }

  const angleCache = getAngleCache(score.angleColumns);
  const rowRadii = new Float64Array(score.radialRows);

  for (let row = 0; row < score.radialRows; row += 1) {
    rowRadii[row] = radialRowToRadius(geometry, score, row);
  }

  const stampCache = Object.freeze({
    angleColumns: score.angleColumns,
    radialRows: score.radialRows,
    innerPlayableRadius: geometry.innerPlayableRadius,
    outerRadius: geometry.outerRadius,
    radialStep:
      (geometry.outerRadius - geometry.innerPlayableRadius) / score.radialRows,
    columnCos: angleCache.cos,
    columnSin: angleCache.sin,
    rowRadii
  });

  stampCacheByScore.set(score, stampCache);

  return stampCache;
}

export function measurePointerSpeed(previousPointer, nextPointer) {
  if (!previousPointer || !nextPointer) {
    return 0;
  }

  const elapsedSeconds = nextPointer.timeSeconds - previousPointer.timeSeconds;

  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0) {
    return 0;
  }

  return (
    Math.hypot(
      nextPointer.x - previousPointer.x,
      nextPointer.y - previousPointer.y
    ) / elapsedSeconds
  );
}

export function getBrushRadiusLimits(
  geometry,
  brushConfig = BRUSH_CONFIG
) {
  validateBrushConfig(brushConfig);

  if (!geometry || !Number.isFinite(geometry.outerRadius)) {
    throw new TypeError("geometry with outerRadius is required.");
  }

  return Object.freeze({
    minRadius: geometry.outerRadius * brushConfig.minRadiusRatio,
    maxRadius: geometry.outerRadius * brushConfig.maxRadiusRatio
  });
}

export function brushRadiusForSpeed(
  pointerSpeed,
  brushConfig = BRUSH_CONFIG,
  geometry
) {
  assertFiniteNumber(pointerSpeed, "pointerSpeed");

  const { minRadius, maxRadius } = getBrushRadiusLimits(geometry, brushConfig);
  const speedT = clamp(
    pointerSpeed / brushConfig.speedForMaxRadiusPxPerSecond,
    0,
    1
  );

  return minRadius + (maxRadius - minRadius) * speedT;
}

export function smoothBrushRadius(
  previousRadius,
  pointerSpeed,
  brushConfig = BRUSH_CONFIG,
  geometry
) {
  const { minRadius, maxRadius } = getBrushRadiusLimits(geometry, brushConfig);
  const targetRadius = brushRadiusForSpeed(pointerSpeed, brushConfig, geometry);
  const startingRadius = Number.isFinite(previousRadius)
    ? previousRadius
    : minRadius;
  const smoothing = clamp(brushConfig.smoothing, 0, 1);

  return clamp(
    startingRadius + (targetRadius - startingRadius) * smoothing,
    minRadius,
    maxRadius
  );
}

function scorePolarToCartesian(scorePolar, radius) {
  const angleRadians = normalizeTurns(scorePolar.angleTurns) * TAU;

  return {
    x: Math.cos(angleRadians) * radius,
    y: Math.sin(angleRadians) * radius
  };
}

function radialTToRadius(geometry, radialT) {
  return (
    geometry.innerPlayableRadius +
    clamp(radialT, 0, 1) *
      (geometry.outerRadius - geometry.innerPlayableRadius)
  );
}

function radialRowToRadius(geometry, score, radialRow) {
  return radialTToRadius(geometry, (radialRow + 0.5) / score.radialRows);
}

function coverageStrength(distance, brushRadius) {
  if (brushRadius <= 0 || distance > brushRadius) {
    return 0;
  }

  const edgeT = clamp(distance / brushRadius, 0, 1);

  return clamp(Math.round(96 + (1 - edgeT) * 159), 1, 255);
}

export function stampBrush(
  score,
  geometry,
  scorePolar,
  brushRadius,
  editMode
) {
  assertFiniteNumber(brushRadius, "brushRadius");

  if (!scorePolar) {
    return Object.freeze({
      affectedCells: [],
      mutationCount: 0
    });
  }

  assertBrushScore(score);

  const isErase = editMode.tool === "erase";
  const colourIndex = isErase ? 0 : editMode.colourIndex;
  assertColourIndex(score, colourIndex);

  const stampCache = getStampCache(score, geometry);
  const centerRadius = radialTToRadius(geometry, scorePolar.radialT);
  const center = scorePolarToCartesian(scorePolar, centerRadius);
  const radialCenterRow = Math.floor(scorePolar.radialT * score.radialRows);
  const radialSpan = Math.ceil(brushRadius / stampCache.radialStep) + 1;
  const minRow = clamp(radialCenterRow - radialSpan, 0, score.radialRows - 1);
  const maxRow = clamp(radialCenterRow + radialSpan, 0, score.radialRows - 1);
  const angularRadius =
    brushRadius / Math.max(centerRadius, stampCache.radialStep);
  const angleSpan =
    Math.ceil((angularRadius / TAU) * score.angleColumns) + 2;
  const centerColumn = Math.floor(
    normalizeTurns(scorePolar.angleTurns) * score.angleColumns
  );
  const brushRadiusSquared = brushRadius * brushRadius;
  const candidateColumnCount = angleSpan * 2 + 1;
  const affectedCells = [];

  function stampCell(row, column, cellRadius) {
    const x = stampCache.columnCos[column] * cellRadius;
    const y = stampCache.columnSin[column] * cellRadius;
    const dx = x - center.x;
    const dy = y - center.y;
    const distanceSquared = dx * dx + dy * dy;

    if (distanceSquared > brushRadiusSquared) {
      return;
    }

    const strength = isErase
      ? 0
      : coverageStrength(Math.sqrt(distanceSquared), brushRadius);
    const storedStrength = colourIndex === 0 ? 0 : strength;
    const index = row * score.angleColumns + column;

    if (
      score.colours[index] === colourIndex &&
      score.strengths[index] === storedStrength
    ) {
      return;
    }

    setCellUnchecked(score, column, row, colourIndex, strength);
    affectedCells.push({
      angleColumn: column,
      radialRow: row
    });
  }

  for (let row = minRow; row <= maxRow; row += 1) {
    const cellRadius = stampCache.rowRadii[row];

    if (candidateColumnCount >= score.angleColumns) {
      for (let column = 0; column < score.angleColumns; column += 1) {
        stampCell(row, column, cellRadius);
      }

      continue;
    }

    for (let offset = -angleSpan; offset <= angleSpan; offset += 1) {
      const column =
        ((centerColumn + offset) % score.angleColumns + score.angleColumns) %
        score.angleColumns;

      stampCell(row, column, cellRadius);
    }
  }

  return Object.freeze({
    affectedCells,
    mutationCount: affectedCells.length
  });
}
