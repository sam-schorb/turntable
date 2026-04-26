import { PLAYHEAD_CONFIG } from "./config.js";
import { createWrappedAngleRange } from "./dirty-regions.js";
import { angleColumnToTurns, radialRowToT } from "./geometry.js";
import { getSlotIndexForColourIndex } from "./sample-slots.js";

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
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

function getAngularBounds(score, cells) {
  const angleRange = createWrappedAngleRange(
    score,
    cells.map((cell) => cell.angleColumn)
  );

  if (!angleRange) {
    return {
      angularStart: 0,
      angularEnd: 0,
      wrapsAngle: false
    };
  }

  return {
    angularStart: angleColumnToTurns(score, angleRange.minAngleColumn),
    angularEnd: angleColumnToTurns(score, angleRange.maxAngleColumn),
    wrapsAngle: angleRange.wraps
  };
}

function countUniqueRows(cells) {
  return new Set(cells.map((cell) => cell.radialRow)).size;
}

function createCoverage(cells, weightedCellCount) {
  const uniqueRows = Math.max(1, countUniqueRows(cells));
  const weightedThicknessCells = weightedCellCount / uniqueRows;

  return clamp01(1 - Math.exp(-weightedThicknessCells / 3));
}

function createDescriptorSortKey(descriptor) {
  return [
    descriptor.colourIndex,
    -descriptor.coverage,
    -descriptor.strength,
    -descriptor.cellCount,
    descriptor.radialCentre,
    descriptor.angularStart
  ];
}

function compareSortKeys(first, second) {
  const firstKey = createDescriptorSortKey(first);
  const secondKey = createDescriptorSortKey(second);

  for (let index = 0; index < firstKey.length; index += 1) {
    if (firstKey[index] < secondKey[index]) {
      return -1;
    }

    if (firstKey[index] > secondKey[index]) {
      return 1;
    }
  }

  return 0;
}

export function computeIslandDescriptor(
  score,
  island,
  transportSnapshot,
  {
    analysisId = 0,
    componentIndex = 0,
    slotMap = getSlotIndexForColourIndex
  } = {}
) {
  assertScoreGrid(score);

  if (!island || !Array.isArray(island.cells) || island.cells.length === 0) {
    throw new TypeError("island must contain cells.");
  }

  const radialValues = island.cells.map((cell) =>
    Number.isFinite(cell.radialT)
      ? clamp01(cell.radialT)
      : radialRowToT(score, cell.radialRow)
  );
  const strengths = island.cells.map((cell) => clamp01(cell.strength / 255));
  const weightSum = strengths.reduce((total, strength) => total + strength, 0);
  const safeWeightSum = weightSum > 0 ? weightSum : island.cells.length;
  const weightedRadialSum = radialValues.reduce(
    (total, radialT, index) =>
      total + radialT * (weightSum > 0 ? strengths[index] : 1),
    0
  );
  const radialStart = Math.min(...radialValues);
  const radialEnd = Math.max(...radialValues);
  const radialCentre = clamp01(weightedRadialSum / safeWeightSum);
  const weightedCellCount = weightSum;
  const strength = clamp01(weightSum / island.cells.length);
  const coverage = createCoverage(island.cells, weightedCellCount);
  const slotIndex = slotMap(island.colourIndex);
  const angularBounds = getAngularBounds(score, island.cells);
  const descriptor = {
    descriptorId: `analysis-${analysisId}:slot-${slotIndex ?? "none"}:component-${componentIndex}`,
    analysisId,
    colourIndex: island.colourIndex,
    slotIndex,
    radialStart,
    radialEnd,
    radialCentre,
    coverage,
    strength,
    cellCount: island.cells.length,
    weightedCellCount,
    radialRowStart: Math.min(...island.cells.map((cell) => cell.radialRow)),
    radialRowEnd: Math.max(...island.cells.map((cell) => cell.radialRow)),
    ...angularBounds,
    wrapsAngle: angularBounds.wrapsAngle,
    componentHint: `colour-${island.colourIndex}-radial-${radialCentre.toFixed(2)}`,
    analysisTime:
      transportSnapshot && Number.isFinite(transportSnapshot.audioTime)
        ? transportSnapshot.audioTime
        : null,
    phaseTurns:
      transportSnapshot && Number.isFinite(transportSnapshot.phaseTurns)
        ? transportSnapshot.phaseTurns
        : 0,
    rankForColour: 0,
    globalRank: 0,
    maxDescriptorsPerSlot: PLAYHEAD_CONFIG.maxDescriptorsPerSlot,
    maxTotalDescriptors: PLAYHEAD_CONFIG.maxTotalDescriptors
  };

  return Object.freeze(descriptor);
}

export function rankDescriptors(descriptors) {
  const sorted = descriptors.slice().sort(compareSortKeys);
  const colourCounts = new Map();

  return sorted.map((descriptor, globalRank) => {
    const nextColourRank = colourCounts.get(descriptor.colourIndex) || 0;

    colourCounts.set(descriptor.colourIndex, nextColourRank + 1);

    return Object.freeze({
      ...descriptor,
      descriptorId: `analysis-${descriptor.analysisId}:slot-${descriptor.slotIndex ?? "none"}:component-${globalRank}`,
      rankForColour: nextColourRank,
      globalRank
    });
  });
}

export function rankDescriptorEntries(entries) {
  const sorted = entries
    .slice()
    .sort((first, second) =>
      compareSortKeys(first.descriptor, second.descriptor)
    );
  const colourCounts = new Map();

  return sorted.map((entry, globalRank) => {
    const descriptor = entry.descriptor;
    const nextColourRank = colourCounts.get(descriptor.colourIndex) || 0;

    colourCounts.set(descriptor.colourIndex, nextColourRank + 1);

    return {
      island: entry.island,
      descriptor: Object.freeze({
        ...descriptor,
        descriptorId: `analysis-${descriptor.analysisId}:slot-${descriptor.slotIndex ?? "none"}:component-${globalRank}`,
        rankForColour: nextColourRank,
        globalRank
      })
    };
  });
}

export function computeIslandDescriptorEntries(
  score,
  islands,
  transportSnapshot,
  options = {}
) {
  if (!Array.isArray(islands) || islands.length === 0) {
    return [];
  }

  const entries = islands.map((island, componentIndex) => ({
    island,
    descriptor: computeIslandDescriptor(score, island, transportSnapshot, {
      ...options,
      componentIndex
    })
  }));

  return rankDescriptorEntries(entries);
}

export function computeIslandDescriptors(
  score,
  islands,
  transportSnapshot,
  options = {}
) {
  return computeIslandDescriptorEntries(
    score,
    islands,
    transportSnapshot,
    options
  ).map((entry) => entry.descriptor);
}

export function createDescriptorPayload({
  analysisId,
  transportSnapshot,
  descriptors
}) {
  if (!Number.isInteger(analysisId) || analysisId < 0) {
    throw new RangeError("analysisId must be a non-negative integer.");
  }

  return Object.freeze({
    type: "playheadDescriptors",
    analysisId,
    audioTime:
      transportSnapshot && Number.isFinite(transportSnapshot.audioTime)
        ? transportSnapshot.audioTime
        : null,
    phaseTurns:
      transportSnapshot && Number.isFinite(transportSnapshot.phaseTurns)
        ? transportSnapshot.phaseTurns
        : 0,
    descriptors: descriptors.slice()
  });
}
