import { PLAYHEAD_CONFIG } from "./config.js";
import {
  scoreCellToPoint,
  TAU
} from "./geometry.js";

function assertGeometry(geometry) {
  if (
    !geometry ||
    !geometry.center ||
    !Number.isFinite(geometry.outerRadius) ||
    !Number.isFinite(geometry.innerPlayableRadius) ||
    !Number.isFinite(geometry.playheadAngleTurns)
  ) {
    throw new TypeError("geometry must be a disc geometry object.");
  }
}

function assertFinitePoint(point) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new TypeError("point must include finite x and y.");
  }
}

function distanceToSegment(point, start, end) {
  const segmentX = end.x - start.x;
  const segmentY = end.y - start.y;
  const segmentLengthSquared = segmentX * segmentX + segmentY * segmentY;

  if (segmentLengthSquared === 0) {
    return {
      distance: Math.hypot(point.x - start.x, point.y - start.y),
      projectionT: 0
    };
  }

  const projectionT = Math.min(
    1,
    Math.max(
      0,
      ((point.x - start.x) * segmentX + (point.y - start.y) * segmentY) /
        segmentLengthSquared
    )
  );
  const closestX = start.x + segmentX * projectionT;
  const closestY = start.y + segmentY * projectionT;

  return {
    distance: Math.hypot(point.x - closestX, point.y - closestY),
    projectionT
  };
}

export function getPlayheadWidth(
  geometry,
  sensorConfig = PLAYHEAD_CONFIG
) {
  assertGeometry(geometry);

  return Math.max(
    sensorConfig.strokeWidthMinPx,
    geometry.outerRadius * sensorConfig.strokeWidthRatio
  );
}

export function getPlayheadCoreWidth(
  geometry,
  sensorConfig = PLAYHEAD_CONFIG
) {
  assertGeometry(geometry);

  return Math.max(
    sensorConfig.coreWidthMinPx,
    geometry.outerRadius * sensorConfig.coreWidthRatio
  );
}

export function getVisiblePlayheadSegment(
  geometry,
  sensorConfig = PLAYHEAD_CONFIG
) {
  assertGeometry(geometry);

  const angleRadians = geometry.playheadAngleTurns * TAU;
  const direction = Object.freeze({
    x: Math.cos(angleRadians),
    y: Math.sin(angleRadians)
  });
  const startRadius = geometry.outerRadius + sensorConfig.outerExtensionPx;
  const endRadius = Math.max(
    0,
    geometry.innerPlayableRadius - sensorConfig.innerExtensionPx
  );

  return Object.freeze({
    angleTurns: geometry.playheadAngleTurns,
    direction,
    start: Object.freeze({
      x: geometry.center.x + direction.x * startRadius,
      y: geometry.center.y + direction.y * startRadius
    }),
    end: Object.freeze({
      x: geometry.center.x + direction.x * endRadius,
      y: geometry.center.y + direction.y * endRadius
    }),
    startRadius,
    endRadius,
    width: getPlayheadWidth(geometry, sensorConfig),
    coreWidth: getPlayheadCoreWidth(geometry, sensorConfig),
    coreInsetPx: sensorConfig.coreInsetPx
  });
}

export function getSensorRegion(
  geometry,
  sensorConfig = PLAYHEAD_CONFIG
) {
  const segment = getVisiblePlayheadSegment(geometry, sensorConfig);

  return Object.freeze({
    ...segment,
    halfWidth: segment.width / 2,
    shape: "capsule"
  });
}

export function isPointInsideSensorRegion(region, point) {
  if (!region || !region.start || !region.end) {
    throw new TypeError("sensor region is required.");
  }

  assertFinitePoint(point);

  const measurement = distanceToSegment(point, region.start, region.end);

  return Object.freeze({
    inside: measurement.distance <= region.halfWidth,
    distanceFromCenterLine: measurement.distance,
    projectionT: measurement.projectionT
  });
}

export function isScoreCellInsideSensor(
  geometry,
  score,
  angleColumn,
  radialRow,
  phaseTurns,
  region = getSensorRegion(geometry)
) {
  const point = scoreCellToPoint(
    geometry,
    score,
    angleColumn,
    radialRow,
    phaseTurns
  );

  if (
    point.radius < geometry.innerPlayableRadius ||
    point.radius > geometry.outerRadius
  ) {
    return Object.freeze({
      inside: false,
      point,
      distanceFromCenterLine: Infinity,
      projectionT: 0
    });
  }

  const measurement = isPointInsideSensorRegion(region, point);

  return Object.freeze({
    ...measurement,
    point
  });
}
