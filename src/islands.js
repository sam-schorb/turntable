function assertScoreGrid(score) {
  if (
    !score ||
    !Number.isInteger(score.angleColumns) ||
    !Number.isInteger(score.radialRows)
  ) {
    throw new TypeError("score must expose angleColumns and radialRows.");
  }
}

function cellKey(score, angleColumn, radialRow) {
  return radialRow * score.angleColumns + angleColumn;
}

function getNeighbourOffsets(adjacency) {
  if (adjacency === "4-way") {
    return [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1]
    ];
  }

  if (adjacency === "8-way") {
    return [
      [-1, -1],
      [0, -1],
      [1, -1],
      [-1, 0],
      [1, 0],
      [-1, 1],
      [0, 1],
      [1, 1]
    ];
  }

  throw new RangeError("adjacency must be either 4-way or 8-way.");
}

function sortCells(cells) {
  return cells.slice().sort((first, second) => {
    if (first.colourIndex !== second.colourIndex) {
      return first.colourIndex - second.colourIndex;
    }

    if (first.radialRow !== second.radialRow) {
      return first.radialRow - second.radialRow;
    }

    return first.angleColumn - second.angleColumn;
  });
}

export function detectIslands(score, sensorCells, { adjacency = "8-way" } = {}) {
  assertScoreGrid(score);

  if (!Array.isArray(sensorCells) || sensorCells.length === 0) {
    return [];
  }

  const neighbourOffsets = getNeighbourOffsets(adjacency);
  const cellsByColour = new Map();

  for (const cell of sortCells(sensorCells)) {
    if (
      !cell ||
      !Number.isInteger(cell.colourIndex) ||
      cell.colourIndex < 1 ||
      !Number.isInteger(cell.angleColumn) ||
      !Number.isInteger(cell.radialRow)
    ) {
      continue;
    }

    if (!cellsByColour.has(cell.colourIndex)) {
      cellsByColour.set(cell.colourIndex, new Map());
    }

    cellsByColour
      .get(cell.colourIndex)
      .set(cellKey(score, cell.angleColumn, cell.radialRow), cell);
  }

  const islands = [];

  for (const [colourIndex, colourCells] of Array.from(cellsByColour.entries()).sort(
    ([firstColour], [secondColour]) => firstColour - secondColour
  )) {
    const visited = new Set();

    for (const [startKey, startCell] of colourCells.entries()) {
      if (visited.has(startKey)) {
        continue;
      }

      const componentCells = [];
      const queue = [startCell];
      let queueIndex = 0;
      visited.add(startKey);

      while (queueIndex < queue.length) {
        const cell = queue[queueIndex];

        queueIndex += 1;

        componentCells.push(cell);

        for (const [angleOffset, radialOffset] of neighbourOffsets) {
          const neighbourAngle =
            ((cell.angleColumn + angleOffset) % score.angleColumns +
              score.angleColumns) %
            score.angleColumns;
          const neighbourRow = cell.radialRow + radialOffset;

          if (neighbourRow < 0 || neighbourRow >= score.radialRows) {
            continue;
          }

          const neighbourKey = cellKey(score, neighbourAngle, neighbourRow);

          if (visited.has(neighbourKey) || !colourCells.has(neighbourKey)) {
            continue;
          }

          visited.add(neighbourKey);
          queue.push(colourCells.get(neighbourKey));
        }
      }

      islands.push(
        Object.freeze({
          colourIndex,
          cells: sortCells(componentCells),
          cellCount: componentCells.length
        })
      );
    }
  }

  return islands;
}
