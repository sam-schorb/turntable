function assertScoreGrid(score) {
  if (
    !score ||
    !Number.isInteger(score.angleColumns) ||
    !Number.isInteger(score.radialRows)
  ) {
    throw new TypeError("score must expose angleColumns and radialRows.");
  }
}

function uniqueSortedIntegers(values) {
  return Array.from(new Set(values)).sort((a, b) => a - b);
}

export function createWrappedAngleRange(score, angleColumns) {
  const columns = uniqueSortedIntegers(angleColumns);

  if (columns.length === 0) {
    return null;
  }

  if (columns.length === score.angleColumns) {
    return {
      minAngleColumn: 0,
      maxAngleColumn: score.angleColumns - 1,
      wraps: false
    };
  }

  if (columns.length === 1) {
    return {
      minAngleColumn: columns[0],
      maxAngleColumn: columns[0],
      wraps: false
    };
  }

  let largestGapSize = -1;
  let largestGapStartsAtIndex = columns.length - 1;

  for (let index = 0; index < columns.length; index += 1) {
    const current = columns[index];
    const next = columns[(index + 1) % columns.length];
    const gapSize =
      index === columns.length - 1
        ? next + score.angleColumns - current - 1
        : next - current - 1;

    if (gapSize > largestGapSize) {
      largestGapSize = gapSize;
      largestGapStartsAtIndex = index;
    }
  }

  const rangeStartIndex = (largestGapStartsAtIndex + 1) % columns.length;
  const minAngleColumn = columns[rangeStartIndex];
  const maxAngleColumn = columns[largestGapStartsAtIndex];

  return {
    minAngleColumn,
    maxAngleColumn,
    wraps: minAngleColumn > maxAngleColumn
  };
}

export function createDirtyRegion(score, affectedCells, editType) {
  assertScoreGrid(score);

  if (!Array.isArray(affectedCells) || affectedCells.length === 0) {
    return null;
  }

  const rows = affectedCells.map((cell) => cell.radialRow);
  const angleRange = createWrappedAngleRange(
    score,
    affectedCells.map((cell) => cell.angleColumn)
  );

  return Object.freeze({
    editType,
    minAngleColumn: angleRange.minAngleColumn,
    maxAngleColumn: angleRange.maxAngleColumn,
    wraps: angleRange.wraps,
    minRadialRow: Math.min(...rows),
    maxRadialRow: Math.max(...rows),
    scoreVersion: score.version,
    fullScore: false
  });
}

export function createFullScoreDirtyRegion(score, editType = "clear") {
  assertScoreGrid(score);

  return Object.freeze({
    editType,
    minAngleColumn: 0,
    maxAngleColumn: score.angleColumns - 1,
    wraps: false,
    minRadialRow: 0,
    maxRadialRow: score.radialRows - 1,
    scoreVersion: score.version,
    fullScore: true
  });
}

export function appendDirtyRegion(queue, region) {
  if (region) {
    queue.push(region);
  }

  return region;
}
