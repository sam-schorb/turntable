import { GEOMETRY_CONFIG } from "./config.js";

export const TAU = Math.PI * 2;

function assertFiniteNumber(value, name) {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number.`);
  }
}

function assertScoreGrid(score) {
  if (
    !score ||
    !Number.isInteger(score.angleColumns) ||
    !Number.isInteger(score.radialRows)
  ) {
    throw new TypeError("score must expose angleColumns and radialRows.");
  }
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

export function normalizeTurns(turns) {
  assertFiniteNumber(turns, "turns");

  return ((turns % 1) + 1) % 1;
}

export function createDiscGeometry(size, config = GEOMETRY_CONFIG) {
  const width = size.width;
  const height = size.height;

  assertFiniteNumber(width, "width");
  assertFiniteNumber(height, "height");

  if (width <= 0 || height <= 0) {
    throw new RangeError("disc geometry dimensions must be greater than 0.");
  }

  const shorterSide = Math.min(width, height);
  const outerRadius = shorterSide * (0.5 - config.discPaddingRatio);
  const center = Object.freeze({
    x: width / 2,
    y: height / 2
  });
  const hubRadius = outerRadius * config.hubRadiusRatio;
  const innerPlayableRadius = outerRadius * config.innerPlayableRadiusRatio;

  return Object.freeze({
    width,
    height,
    center,
    outerRadius,
    hubRadius,
    innerPlayableRadius,
    playheadAngleTurns: config.playheadAngleTurns,
    guideRadii: Object.freeze([
      innerPlayableRadius,
      innerPlayableRadius + (outerRadius - innerPlayableRadius) * 0.5,
      outerRadius
    ])
  });
}

export function radialRowToT(score, radialRow) {
  assertScoreGrid(score);

  if (!Number.isInteger(radialRow)) {
    throw new TypeError("radialRow must be an integer.");
  }

  if (radialRow < 0 || radialRow >= score.radialRows) {
    throw new RangeError(`radialRow must be from 0 to ${score.radialRows - 1}.`);
  }

  return (radialRow + 0.5) / score.radialRows;
}

export function radialRowToRadius(geometry, score, radialRow) {
  const radialT = radialRowToT(score, radialRow);

  return (
    geometry.innerPlayableRadius +
    radialT * (geometry.outerRadius - geometry.innerPlayableRadius)
  );
}

export function angleColumnToTurns(score, angleColumn) {
  assertScoreGrid(score);

  if (!Number.isInteger(angleColumn)) {
    throw new TypeError("angleColumn must be an integer.");
  }

  const wrappedColumn =
    ((angleColumn % score.angleColumns) + score.angleColumns) %
    score.angleColumns;

  return (wrappedColumn + 0.5) / score.angleColumns;
}

export function scoreAngleToScreenAngleRadians(
  angleTurns,
  phaseTurns,
  playheadAngleTurns = GEOMETRY_CONFIG.playheadAngleTurns
) {
  assertFiniteNumber(angleTurns, "angleTurns");
  assertFiniteNumber(phaseTurns, "phaseTurns");

  return (playheadAngleTurns + angleTurns - phaseTurns) * TAU;
}

export function scoreCellToPoint(
  geometry,
  score,
  angleColumn,
  radialRow,
  phaseTurns = 0
) {
  const radius = radialRowToRadius(geometry, score, radialRow);
  const angleTurns = angleColumnToTurns(score, angleColumn);
  const screenAngle = scoreAngleToScreenAngleRadians(
    angleTurns,
    phaseTurns,
    geometry.playheadAngleTurns
  );

  return Object.freeze({
    x: geometry.center.x + Math.cos(screenAngle) * radius,
    y: geometry.center.y + Math.sin(screenAngle) * radius,
    radius,
    angleRadians: screenAngle
  });
}

export function clientPointToDiscPoint(canvas, clientX, clientY, geometry) {
  if (!canvas || typeof canvas.getBoundingClientRect !== "function") {
    throw new TypeError("canvas must expose getBoundingClientRect.");
  }

  assertFiniteNumber(clientX, "clientX");
  assertFiniteNumber(clientY, "clientY");

  const rect = canvas.getBoundingClientRect();
  const width = geometry ? geometry.width : rect.width;
  const height = geometry ? geometry.height : rect.height;
  const center = geometry
    ? geometry.center
    : {
        x: width / 2,
        y: height / 2
      };
  const canvasX = ((clientX - rect.left) / rect.width) * width;
  const canvasY = ((clientY - rect.top) / rect.height) * height;
  const x = canvasX - center.x;
  const y = canvasY - center.y;

  return Object.freeze({
    canvasX,
    canvasY,
    x,
    y,
    radius: Math.hypot(x, y)
  });
}

export function discPointToPlayablePolar(geometry, discPoint) {
  if (!geometry) {
    throw new TypeError("geometry is required.");
  }

  if (!discPoint || !Number.isFinite(discPoint.radius)) {
    throw new TypeError("discPoint must include a finite radius.");
  }

  if (
    discPoint.radius < geometry.innerPlayableRadius ||
    discPoint.radius > geometry.outerRadius
  ) {
    return null;
  }

  return Object.freeze({
    angleTurns: normalizeTurns(Math.atan2(discPoint.y, discPoint.x) / TAU),
    radialT: clamp01(
      (discPoint.radius - geometry.innerPlayableRadius) /
        (geometry.outerRadius - geometry.innerPlayableRadius)
    ),
    radius: discPoint.radius
  });
}

export function screenPolarToScorePolar(
  transportSnapshot,
  screenPolar,
  geometryOrPlayheadAngleTurns = GEOMETRY_CONFIG.playheadAngleTurns
) {
  if (!screenPolar) {
    return null;
  }

  const playheadAngleTurns =
    typeof geometryOrPlayheadAngleTurns === "number"
      ? geometryOrPlayheadAngleTurns
      : geometryOrPlayheadAngleTurns.playheadAngleTurns;
  const phaseTurns = transportSnapshot ? transportSnapshot.phaseTurns : 0;

  assertFiniteNumber(playheadAngleTurns, "playheadAngleTurns");
  assertFiniteNumber(phaseTurns, "phaseTurns");

  return Object.freeze({
    angleTurns: normalizeTurns(
      screenPolar.angleTurns - playheadAngleTurns + phaseTurns
    ),
    radialT: clamp01(screenPolar.radialT),
    radius: screenPolar.radius
  });
}

export function scorePolarToCell(score, scorePolar) {
  assertScoreGrid(score);

  if (!scorePolar) {
    return null;
  }

  assertFiniteNumber(scorePolar.angleTurns, "scorePolar.angleTurns");
  assertFiniteNumber(scorePolar.radialT, "scorePolar.radialT");

  return Object.freeze({
    angleColumn: Math.floor(normalizeTurns(scorePolar.angleTurns) * score.angleColumns) %
      score.angleColumns,
    radialRow: Math.min(
      score.radialRows - 1,
      Math.max(0, Math.floor(clamp01(scorePolar.radialT) * score.radialRows))
    )
  });
}

export function radialMultiplierAtT(
  radialT,
  config = GEOMETRY_CONFIG
) {
  assertFiniteNumber(radialT, "radialT");

  const clampedT = clamp01(radialT);

  if (clampedT <= 0.5) {
    return (
      config.radialRateMin +
      (clampedT / 0.5) * (config.radialRateMid - config.radialRateMin)
    );
  }

  return (
    config.radialRateMid +
    ((clampedT - 0.5) / 0.5) *
      (config.radialRateMax - config.radialRateMid)
  );
}

export function radialRowToMultiplier(score, radialRow, config = GEOMETRY_CONFIG) {
  return radialMultiplierAtT(radialRowToT(score, radialRow), config);
}
