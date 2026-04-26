import { SCORE_CONFIG } from "./config.js";

function assertPositiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer.`);
  }
}

function assertIntegerInRange(value, min, max, name) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer from ${min} to ${max}.`);
  }
}

function assertScoreShape(score) {
  if (
    !score ||
    !Number.isInteger(score.angleColumns) ||
    !Number.isInteger(score.radialRows) ||
    !(score.colours instanceof Uint8Array) ||
    !(score.strengths instanceof Uint8Array)
  ) {
    throw new TypeError("score must be a polar score created by createScore.");
  }
}

export function normaliseAngleColumn(score, angleColumn) {
  assertScoreShape(score);

  if (!Number.isInteger(angleColumn)) {
    throw new TypeError("angleColumn must be an integer.");
  }

  return (
    ((angleColumn % score.angleColumns) + score.angleColumns) %
    score.angleColumns
  );
}

export function validateRadialRow(score, radialRow) {
  assertScoreShape(score);

  if (!Number.isInteger(radialRow)) {
    throw new TypeError("radialRow must be an integer.");
  }

  if (radialRow < 0 || radialRow >= score.radialRows) {
    throw new RangeError(
      `radialRow must be from 0 to ${score.radialRows - 1}.`
    );
  }
}

export function cellToIndex(score, angleColumn, radialRow) {
  const wrappedAngleColumn = normaliseAngleColumn(score, angleColumn);

  validateRadialRow(score, radialRow);

  return radialRow * score.angleColumns + wrappedAngleColumn;
}

export function createScore(options = {}) {
  const angleColumns = options.angleColumns ?? SCORE_CONFIG.angleColumns;
  const radialRows = options.radialRows ?? SCORE_CONFIG.radialRows;
  const colourCount = options.colourCount ?? SCORE_CONFIG.colourCount;

  assertPositiveInteger(angleColumns, "angleColumns");
  assertPositiveInteger(radialRows, "radialRows");
  assertIntegerInRange(colourCount, 1, 255, "colourCount");

  const cellCount = angleColumns * radialRows;

  if (!Number.isSafeInteger(cellCount)) {
    throw new RangeError("score cell count is too large.");
  }

  return {
    angleColumns,
    radialRows,
    colourCount,
    colours: new Uint8Array(cellCount),
    strengths: new Uint8Array(cellCount),
    version: 0,
    nonEmptyIndices: new Set()
  };
}

export function clearScore(score) {
  assertScoreShape(score);

  score.colours.fill(0);
  score.strengths.fill(0);
  score.nonEmptyIndices.clear();
  score.version += 1;

  return score;
}

export function getCell(score, angleColumn, radialRow) {
  const index = cellToIndex(score, angleColumn, radialRow);
  const colourIndex = score.colours[index];
  const strength = colourIndex === 0 ? 0 : score.strengths[index];

  return {
    colourIndex,
    strength,
    isEmpty: colourIndex === 0
  };
}

export function setCell(
  score,
  angleColumn,
  radialRow,
  colourIndex,
  strength
) {
  assertScoreShape(score);
  assertIntegerInRange(colourIndex, 0, score.colourCount, "colourIndex");
  assertIntegerInRange(strength, 0, 255, "strength");

  const index = cellToIndex(score, angleColumn, radialRow);
  const storedStrength = colourIndex === 0 ? 0 : strength;

  score.colours[index] = colourIndex;
  score.strengths[index] = storedStrength;

  if (colourIndex === 0 || storedStrength === 0) {
    score.nonEmptyIndices.delete(index);
  } else {
    score.nonEmptyIndices.add(index);
  }

  score.version += 1;

  return score;
}

export function setCellUnchecked(
  score,
  angleColumn,
  radialRow,
  colourIndex,
  strength
) {
  const index = radialRow * score.angleColumns + angleColumn;
  const storedStrength = colourIndex === 0 ? 0 : strength;

  score.colours[index] = colourIndex;
  score.strengths[index] = storedStrength;

  if (colourIndex === 0 || storedStrength === 0) {
    score.nonEmptyIndices.delete(index);
  } else {
    score.nonEmptyIndices.add(index);
  }

  score.version += 1;

  return score;
}

export function getNonEmptyCellIndices(score) {
  assertScoreShape(score);

  return score.nonEmptyIndices.values();
}

export function createInitialScoreState() {
  return Object.freeze({
    status: "authoritative_polar_grid",
    angleColumns: SCORE_CONFIG.angleColumns,
    radialRows: SCORE_CONFIG.radialRows,
    colourCellCount: SCORE_CONFIG.angleColumns * SCORE_CONFIG.radialRows,
    version: 0
  });
}
