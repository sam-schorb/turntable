import { PLAYHEAD_CONFIG } from "./config.js";
import {
  computeIslandDescriptorEntries,
  createDescriptorPayload
} from "./descriptors.js";
import { normalizeTurns, TAU } from "./geometry.js";
import { detectIslands } from "./islands.js";
import { getSensorRegion } from "./sensor-geometry.js";
import { getNonEmptyCellIndices } from "./score.js";
import { getSlotIndexForColourIndex } from "./sample-slots.js";

const analysisCacheByScore = new WeakMap();
const angleCacheByColumnCount = new Map();

function assertScore(score) {
  if (
    !score ||
    !Number.isInteger(score.angleColumns) ||
    !Number.isInteger(score.radialRows) ||
    !(score.colours instanceof Uint8Array) ||
    !(score.strengths instanceof Uint8Array)
  ) {
    throw new TypeError("score must be a polar score.");
  }
}

function resolveGeometry(analyzer, geometryOverride) {
  const geometry =
    geometryOverride ||
    (typeof analyzer.getGeometry === "function"
      ? analyzer.getGeometry()
      : analyzer.geometry);

  if (!geometry) {
    throw new Error("playhead analyzer requires current disc geometry.");
  }

  return geometry;
}

function createDefaultTransportSnapshot() {
  return Object.freeze({
    phaseTurns: 0,
    audioTime: null
  });
}

function normalizeTransportSnapshot(transportSnapshot) {
  if (!transportSnapshot) {
    return createDefaultTransportSnapshot();
  }

  return Object.freeze({
    ...transportSnapshot,
    phaseTurns: Number.isFinite(transportSnapshot.phaseTurns)
      ? transportSnapshot.phaseTurns
      : 0,
    audioTime: Number.isFinite(transportSnapshot.audioTime)
      ? transportSnapshot.audioTime
      : null
  });
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function getAngleCache(angleColumns) {
  let angleCache = angleCacheByColumnCount.get(angleColumns);

  if (angleCache) {
    return angleCache;
  }

  const turns = new Float64Array(angleColumns);
  const cos = new Float64Array(angleColumns);
  const sin = new Float64Array(angleColumns);

  for (let column = 0; column < angleColumns; column += 1) {
    const angleTurns = (column + 0.5) / angleColumns;
    const angleRadians = angleTurns * TAU;

    turns[column] = angleTurns;
    cos[column] = Math.cos(angleRadians);
    sin[column] = Math.sin(angleRadians);
  }

  angleCache = Object.freeze({
    angleColumns,
    turns,
    cos,
    sin
  });
  angleCacheByColumnCount.set(angleColumns, angleCache);

  return angleCache;
}

function getAnalysisCache(score, geometry) {
  const cached = analysisCacheByScore.get(score);

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
  const rowRadialTs = new Float64Array(score.radialRows);
  const playableRadiusSpan =
    geometry.outerRadius - geometry.innerPlayableRadius;

  for (let row = 0; row < score.radialRows; row += 1) {
    const radialT = (row + 0.5) / score.radialRows;

    rowRadialTs[row] = radialT;
    rowRadii[row] = geometry.innerPlayableRadius + radialT * playableRadiusSpan;
  }

  const analysisCache = Object.freeze({
    angleColumns: score.angleColumns,
    radialRows: score.radialRows,
    innerPlayableRadius: geometry.innerPlayableRadius,
    outerRadius: geometry.outerRadius,
    columnTurns: angleCache.turns,
    columnCos: angleCache.cos,
    columnSin: angleCache.sin,
    rowRadii,
    rowRadialTs
  });

  analysisCacheByScore.set(score, analysisCache);

  return analysisCache;
}

function createMeasurementContext(score, geometry, region, phaseTurns) {
  const cache = getAnalysisCache(score, geometry);
  const phaseRadians = phaseTurns * TAU;
  const phaseCos = Math.cos(phaseRadians);
  const phaseSin = Math.sin(phaseRadians);

  return {
    geometry,
    region,
    cache,
    phaseTurns,
    phaseCos,
    phaseSin,
    segmentRadiusDelta: region.endRadius - region.startRadius,
    perpendicularDirectionX: -region.direction.y,
    perpendicularDirectionY: region.direction.x
  };
}

function measureScoreCellInSensor(context, angleColumn, radialRow) {
  const radius = context.cache.rowRadii[radialRow];

  if (
    radius < context.geometry.innerPlayableRadius ||
    radius > context.geometry.outerRadius
  ) {
    return null;
  }

  const columnCos = context.cache.columnCos[angleColumn];
  const columnSin = context.cache.columnSin[angleColumn];
  const deltaCos =
    columnCos * context.phaseCos + columnSin * context.phaseSin;
  const deltaSin =
    columnSin * context.phaseCos - columnCos * context.phaseSin;
  const parallelDistance = radius * deltaCos;
  const perpendicularDistance = radius * deltaSin;
  const projectionT =
    context.segmentRadiusDelta === 0
      ? 0
      : clamp(
          (parallelDistance - context.region.startRadius) /
            context.segmentRadiusDelta,
          0,
          1
        );
  const closestParallelDistance =
    context.region.startRadius +
    context.segmentRadiusDelta * projectionT;
  const centerLineDelta = parallelDistance - closestParallelDistance;
  const distanceFromCenterLineSquared =
    centerLineDelta * centerLineDelta +
    perpendicularDistance * perpendicularDistance;
  const halfWidthSquared = context.region.halfWidth * context.region.halfWidth;

  if (distanceFromCenterLineSquared > halfWidthSquared) {
    return null;
  }

  const distanceFromCenterLine = Math.sqrt(distanceFromCenterLineSquared);

  return {
    point: {
      x:
        context.geometry.center.x +
        context.region.direction.x * parallelDistance +
        context.perpendicularDirectionX * perpendicularDistance,
      y:
        context.geometry.center.y +
        context.region.direction.y * parallelDistance +
        context.perpendicularDirectionY * perpendicularDistance,
      radius,
      angleRadians:
        (context.geometry.playheadAngleTurns +
          context.cache.columnTurns[angleColumn] -
          context.phaseTurns) *
        TAU
    },
    distanceFromCenterLine,
    projectionT
  };
}

function createSensorCell(
  score,
  index,
  angleColumn,
  radialRow,
  measurement,
  region,
  radialT
) {
  return Object.freeze({
    index,
    angleColumn,
    radialRow,
    colourIndex: score.colours[index],
    strength: score.strengths[index],
    radialT,
    radius: measurement.point.radius,
    point: measurement.point,
    distanceFromCenterLine: measurement.distanceFromCenterLine,
    sensorDistanceT:
      Number.isFinite(measurement.distanceFromCenterLine) && region
        ? Math.min(
            1,
            Math.max(
              0,
              measurement.distanceFromCenterLine / Math.max(1, region.halfWidth)
            )
          )
        : 1,
    projectionT: measurement.projectionT
  });
}

function isValidPaintedCell(score, index) {
  const colourIndex = score.colours[index];
  const strength = score.strengths[index];

  return (
    colourIndex >= 1 &&
    colourIndex <= score.colourCount &&
    strength > 0
  );
}

function getReaderWindowColumns(score, geometry, region, phaseTurns) {
  const minimumSensorRadius = Math.max(
    1,
    Math.min(
      geometry.innerPlayableRadius,
      Number.isFinite(region.endRadius) ? region.endRadius : geometry.innerPlayableRadius
    )
  );
  const angularHalfWidthTurns =
    Math.asin(Math.min(1, region.halfWidth / minimumSensorRadius)) /
    (Math.PI * 2);
  const span = Math.min(
    score.angleColumns,
    Math.ceil(angularHalfWidthTurns * score.angleColumns) + 4
  );
  const centerColumn = Math.floor(
    normalizeTurns(phaseTurns) * score.angleColumns
  ) % score.angleColumns;
  const columnCount = Math.min(score.angleColumns, span * 2 + 1);
  const columns = [];

  if (columnCount >= score.angleColumns) {
    for (let column = 0; column < score.angleColumns; column += 1) {
      columns.push(column);
    }

    return columns;
  }

  for (let offset = -span; offset <= span; offset += 1) {
    columns.push(
      ((centerColumn + offset) % score.angleColumns + score.angleColumns) %
        score.angleColumns
    );
  }

  return columns;
}

function collectSensorCellsFromPaintedCells(
  analyzer,
  snapshot,
  geometry,
  region
) {
  const cells = [];
  const context = createMeasurementContext(
    analyzer.score,
    geometry,
    region,
    snapshot.phaseTurns
  );

  for (const index of getNonEmptyCellIndices(analyzer.score)) {
    if (!isValidPaintedCell(analyzer.score, index)) {
      continue;
    }

    const angleColumn = index % analyzer.score.angleColumns;
    const radialRow = Math.floor(index / analyzer.score.angleColumns);
    const measurement = measureScoreCellInSensor(
      context,
      angleColumn,
      radialRow
    );

    if (measurement) {
      cells.push(
        createSensorCell(
          analyzer.score,
          index,
          angleColumn,
          radialRow,
          measurement,
          region,
          context.cache.rowRadialTs[radialRow]
        )
      );
    }
  }

  analyzer.lastScanMode = "painted-cells";
  analyzer.lastCandidateCellCount = analyzer.score.nonEmptyIndices
    ? analyzer.score.nonEmptyIndices.size
    : cells.length;
  return cells;
}

function collectSensorCellsFromReaderWindow(
  analyzer,
  snapshot,
  geometry,
  region,
  columns
) {
  const cells = [];
  const context = createMeasurementContext(
    analyzer.score,
    geometry,
    region,
    snapshot.phaseTurns
  );

  for (const angleColumn of columns) {
    for (let radialRow = 0; radialRow < analyzer.score.radialRows; radialRow += 1) {
      const index = radialRow * analyzer.score.angleColumns + angleColumn;

      if (!isValidPaintedCell(analyzer.score, index)) {
        continue;
      }

      const measurement = measureScoreCellInSensor(
        context,
        angleColumn,
        radialRow
      );

      if (measurement) {
        cells.push(
          createSensorCell(
            analyzer.score,
            index,
            angleColumn,
            radialRow,
            measurement,
            region,
            context.cache.rowRadialTs[radialRow]
          )
        );
      }
    }
  }

  analyzer.lastScanMode = "reader-window";
  analyzer.lastCandidateCellCount = columns.length * analyzer.score.radialRows;
  return cells;
}

export function createPlayheadAnalyzer({
  score,
  geometry,
  getGeometry,
  sensorConfig = PLAYHEAD_CONFIG,
  slotMap = getSlotIndexForColourIndex,
  config = PLAYHEAD_CONFIG
} = {}) {
  assertScore(score);

  if (!geometry && typeof getGeometry !== "function") {
    throw new TypeError("geometry or getGeometry is required.");
  }

  return {
    status: "local_island_descriptors",
    score,
    geometry,
    getGeometry,
    sensorConfig,
    slotMap,
    config,
    analysisId: 0,
    invalidationSequence: 0,
    dirty: true,
    lastScoreVersion: score.version,
    lastPayload: createDescriptorPayload({
      analysisId: 0,
      transportSnapshot: createDefaultTransportSnapshot(),
      descriptors: []
    }),
    lastSensorCellCount: 0,
    lastIslandCount: 0,
    lastScanMode: "none",
    lastCandidateCellCount: 0,
    lastDirtyRegions: []
  };
}

export function getAnalyzerState(analyzer) {
  return Object.freeze({
    status: analyzer.status,
    analysisId: analyzer.analysisId,
    descriptorCount: analyzer.lastPayload
      ? analyzer.lastPayload.descriptors.length
      : 0,
    sensorCellCount: analyzer.lastSensorCellCount,
    islandCount: analyzer.lastIslandCount,
    scanMode: analyzer.lastScanMode,
    candidateCellCount: analyzer.lastCandidateCellCount,
    dirty: analyzer.dirty,
    invalidationSequence: analyzer.invalidationSequence
  });
}

export function getSensorRegionForSnapshot(
  analyzer,
  transportSnapshot,
  geometryOverride
) {
  resolveGeometry(analyzer, geometryOverride);
  normalizeTransportSnapshot(transportSnapshot);

  return getSensorRegion(
    resolveGeometry(analyzer, geometryOverride),
    analyzer.sensorConfig
  );
}

export function collectSensorCells(
  analyzer,
  transportSnapshot,
  geometryOverride
) {
  const snapshot = normalizeTransportSnapshot(transportSnapshot);
  const geometry = resolveGeometry(analyzer, geometryOverride);
  const region = getSensorRegion(geometry, analyzer.sensorConfig);
  const columns = getReaderWindowColumns(
    analyzer.score,
    geometry,
    region,
    snapshot.phaseTurns
  );
  const paintedCellCount = analyzer.score.nonEmptyIndices
    ? analyzer.score.nonEmptyIndices.size
    : Infinity;
  const readerCandidateCellCount = columns.length * analyzer.score.radialRows;

  if (paintedCellCount === 0) {
    analyzer.lastScanMode = "empty-score";
    analyzer.lastCandidateCellCount = 0;
    return [];
  }

  if (
    paintedCellCount > 0 &&
    paintedCellCount < Math.max(1, readerCandidateCellCount / 8)
  ) {
    return collectSensorCellsFromPaintedCells(
      analyzer,
      snapshot,
      geometry,
      region
    );
  }

  return collectSensorCellsFromReaderWindow(
    analyzer,
    snapshot,
    geometry,
    region,
    columns
  );
}

export function computePlayheadIslands(analyzer, sensorCells) {
  return detectIslands(analyzer.score, sensorCells, {
    adjacency: analyzer.config.adjacency
  });
}

export function analyzePlayhead(
  analyzer,
  transportSnapshot,
  { geometry } = {}
) {
  const snapshot = normalizeTransportSnapshot(transportSnapshot);
  const analysisId = analyzer.analysisId + 1;
  const sensorCells = collectSensorCells(analyzer, snapshot, geometry);
  const islands = computePlayheadIslands(analyzer, sensorCells);
  const descriptorEntries = computeIslandDescriptorEntries(
    analyzer.score,
    islands,
    snapshot,
    {
      analysisId,
      slotMap: analyzer.slotMap
    }
  );
  const descriptors = descriptorEntries.map((entry) => entry.descriptor);
  const payload = createDescriptorPayload({
    analysisId,
    transportSnapshot: snapshot,
    descriptors
  });
  analyzer.analysisId = analysisId;
  analyzer.lastPayload = payload;
  analyzer.lastSensorCellCount = sensorCells.length;
  analyzer.lastIslandCount = islands.length;
  analyzer.lastScoreVersion = analyzer.score.version;
  analyzer.dirty = false;

  return payload;
}

export function invalidateDescriptors(analyzer, dirtyRegions = []) {
  const regions = Array.isArray(dirtyRegions) ? dirtyRegions : [dirtyRegions];
  const realRegions = regions.filter(Boolean);

  if (realRegions.length === 0) {
    return Object.freeze({
      invalidated: false,
      invalidationSequence: analyzer.invalidationSequence
    });
  }

  analyzer.dirty = true;
  analyzer.invalidationSequence += 1;
  analyzer.lastDirtyRegions = realRegions.map((region) =>
    Object.freeze({
      editType: region.editType,
      fullScore: Boolean(region.fullScore),
      wraps: Boolean(region.wraps),
      minAngleColumn: region.minAngleColumn,
      maxAngleColumn: region.maxAngleColumn,
      minRadialRow: region.minRadialRow,
      maxRadialRow: region.maxRadialRow,
      scoreVersion: region.scoreVersion
    })
  );

  return Object.freeze({
    invalidated: true,
    invalidationSequence: analyzer.invalidationSequence,
    dirtyRegionCount: realRegions.length
  });
}

export function createInitialPlayheadAnalysisState() {
  return Object.freeze({
    status: "local_island_descriptors",
    analysisId: 0,
    descriptorCount: 0,
    sensorCellCount: 0,
    islandCount: 0,
    analysisSubsteps: PLAYHEAD_CONFIG.analysisSubsteps
  });
}
