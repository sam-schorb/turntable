import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  brushRadiusForSpeed,
  measurePointerSpeed,
  smoothBrushRadius,
  stampBrush
} from "../src/brush.js";
import { createDiscGeometry, normalizeTurns, TAU } from "../src/geometry.js";
import { createScore, getCell, setCell } from "../src/score.js";

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function createTestGeometry() {
  return createDiscGeometry({ width: 640, height: 640 });
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

function angleColumnToTurns(score, angleColumn) {
  return (angleColumn + 0.5) / score.angleColumns;
}

function scorePolarToCartesian(scorePolar, radius) {
  const angleRadians = normalizeTurns(scorePolar.angleTurns) * TAU;

  return {
    x: Math.cos(angleRadians) * radius,
    y: Math.sin(angleRadians) * radius
  };
}

function coverageStrength(distance, brushRadius) {
  if (brushRadius <= 0 || distance > brushRadius) {
    return 0;
  }

  const edgeT = clamp(distance / brushRadius, 0, 1);

  return clamp(Math.round(96 + (1 - edgeT) * 159), 1, 255);
}

function stampBrushReference(score, geometry, scorePolar, brushRadius, editMode) {
  if (!scorePolar) {
    return {
      affectedCells: [],
      mutationCount: 0
    };
  }

  const isErase = editMode.tool === "erase";
  const colourIndex = isErase ? 0 : editMode.colourIndex;
  const centerRadius = radialTToRadius(geometry, scorePolar.radialT);
  const center = scorePolarToCartesian(scorePolar, centerRadius);
  const radialStep =
    (geometry.outerRadius - geometry.innerPlayableRadius) / score.radialRows;
  const radialCenterRow = Math.floor(scorePolar.radialT * score.radialRows);
  const radialSpan = Math.ceil(brushRadius / radialStep) + 1;
  const minRow = clamp(radialCenterRow - radialSpan, 0, score.radialRows - 1);
  const maxRow = clamp(radialCenterRow + radialSpan, 0, score.radialRows - 1);
  const angularRadius = brushRadius / Math.max(centerRadius, radialStep);
  const angleSpan =
    Math.ceil((angularRadius / TAU) * score.angleColumns) + 2;
  const centerColumn = Math.floor(
    normalizeTurns(scorePolar.angleTurns) * score.angleColumns
  );
  const affectedCells = [];
  const seenCells = new Set();

  for (let row = minRow; row <= maxRow; row += 1) {
    const cellRadius = radialRowToRadius(geometry, score, row);

    for (let offset = -angleSpan; offset <= angleSpan; offset += 1) {
      const column =
        ((centerColumn + offset) % score.angleColumns + score.angleColumns) %
        score.angleColumns;
      const key = `${column}:${row}`;

      if (seenCells.has(key)) {
        continue;
      }

      seenCells.add(key);

      const cellPoint = scorePolarToCartesian(
        {
          angleTurns: angleColumnToTurns(score, column)
        },
        cellRadius
      );
      const distance = Math.hypot(cellPoint.x - center.x, cellPoint.y - center.y);

      if (distance > brushRadius) {
        continue;
      }

      const strength = isErase ? 0 : coverageStrength(distance, brushRadius);
      const storedStrength = colourIndex === 0 ? 0 : strength;
      const scoreIndex = row * score.angleColumns + column;

      if (
        score.colours[scoreIndex] === colourIndex &&
        score.strengths[scoreIndex] === storedStrength
      ) {
        continue;
      }

      setCell(score, column, row, colourIndex, strength);
      affectedCells.push({
        angleColumn: column,
        radialRow: row
      });
    }
  }

  return {
    affectedCells,
    mutationCount: affectedCells.length
  };
}

function affectedCellKeys(result) {
  return result.affectedCells
    .map((cell) => `${cell.angleColumn}:${cell.radialRow}`)
    .sort();
}

function assertBrushMatchesReference(fixture) {
  const geometry = createDiscGeometry(fixture.geometrySize || {
    width: 640,
    height: 640
  });
  const scoreOptions = fixture.scoreOptions || {
    angleColumns: 256,
    radialRows: 64
  };
  const expectedScore = createScore(scoreOptions);
  const actualScore = createScore(scoreOptions);

  if (fixture.setup) {
    fixture.setup(expectedScore);
    fixture.setup(actualScore);
  }

  const expected = stampBrushReference(
    expectedScore,
    geometry,
    fixture.scorePolar,
    fixture.brushRadius,
    fixture.editMode
  );
  const actual = stampBrush(
    actualScore,
    geometry,
    fixture.scorePolar,
    fixture.brushRadius,
    fixture.editMode
  );

  assert.deepEqual(Array.from(actualScore.colours), Array.from(expectedScore.colours));
  assert.deepEqual(
    Array.from(actualScore.strengths),
    Array.from(expectedScore.strengths)
  );
  assert.deepEqual(
    Array.from(actualScore.nonEmptyIndices).sort((first, second) => first - second),
    Array.from(expectedScore.nonEmptyIndices).sort((first, second) => first - second)
  );
  assert.equal(actualScore.version, expectedScore.version);
  assert.equal(actual.mutationCount, expected.mutationCount);
  assert.deepEqual(affectedCellKeys(actual), affectedCellKeys(expected));
}

describe("brush helpers", () => {
  it("measures pointer speed from actual pointer movement", () => {
    const stationarySpeed = measurePointerSpeed(
      { x: 10, y: 10, timeSeconds: 0 },
      { x: 10, y: 10, timeSeconds: 1 }
    );
    const movingSpeed = measurePointerSpeed(
      { x: 10, y: 10, timeSeconds: 0 },
      { x: 110, y: 10, timeSeconds: 0.5 }
    );

    assert.equal(stationarySpeed, 0);
    assert.equal(movingSpeed, 200);
  });

  it("maps pointer speed to a clamped smoothed brush radius", () => {
    const geometry = createTestGeometry();
    const brushConfig = {
      minRadiusRatio: 0.01,
      maxRadiusRatio: 0.05,
      speedForMaxRadiusPxPerSecond: 100,
      smoothing: 1,
      stampSpacingRatio: 0.65
    };
    const slowRadius = brushRadiusForSpeed(0, brushConfig, geometry);
    const fastRadius = brushRadiusForSpeed(100, brushConfig, geometry);
    const clampedRadius = brushRadiusForSpeed(10000, brushConfig, geometry);

    assert.ok(slowRadius < fastRadius);
    assert.equal(fastRadius, clampedRadius);
    assert.ok(
      Math.abs(smoothBrushRadius(fastRadius, 0, brushConfig, geometry) - slowRadius) <
        1e-9
    );
  });

  it("stamps paint into polar score cells with bounded strength", () => {
    const geometry = createTestGeometry();
    const score = createScore({ angleColumns: 256, radialRows: 64 });
    const result = stampBrush(
      score,
      geometry,
      { angleTurns: 0.25, radialT: 0.5 },
      12,
      { tool: "paint", colourIndex: 3 }
    );

    assert.ok(result.mutationCount > 0);
    assert.equal(
      result.affectedCells.every((cell) => {
        const stored = getCell(score, cell.angleColumn, cell.radialRow);

        return (
          stored.colourIndex === 3 &&
          stored.strength >= 1 &&
          stored.strength <= 255
        );
      }),
      true
    );
  });

  it("replaces old colour with newest paint and updates same-colour version", () => {
    const geometry = createTestGeometry();
    const score = createScore({ angleColumns: 256, radialRows: 64 });
    const scorePolar = { angleTurns: 0.25, radialT: 0.5 };

    stampBrush(score, geometry, scorePolar, 10, {
      tool: "paint",
      colourIndex: 1
    });
    stampBrush(score, geometry, scorePolar, 10, {
      tool: "paint",
      colourIndex: 5
    });

    const paintedCell = Array.from(score.nonEmptyIndices).find(
      (index) => score.colours[index] === 5
    );
    const versionAfterReplace = score.version;

    assert.notEqual(paintedCell, undefined);
    assert.equal(score.colours[paintedCell], 5);

    stampBrush(score, geometry, scorePolar, 8, {
      tool: "paint",
      colourIndex: 5
    });

    assert.ok(score.version > versionAfterReplace);
  });

  it("does not dirty or version exact repeat stamps", () => {
    const geometry = createTestGeometry();
    const score = createScore({ angleColumns: 256, radialRows: 64 });
    const scorePolar = { angleTurns: 0.25, radialT: 0.5 };
    const first = stampBrush(score, geometry, scorePolar, 10, {
      tool: "paint",
      colourIndex: 3
    });
    const versionAfterFirstStamp = score.version;
    const second = stampBrush(score, geometry, scorePolar, 10, {
      tool: "paint",
      colourIndex: 3
    });

    assert.ok(first.mutationCount > 0);
    assert.equal(second.mutationCount, 0);
    assert.equal(second.affectedCells.length, 0);
    assert.equal(score.version, versionAfterFirstStamp);
  });

  it("erases cells using the same stamp path", () => {
    const geometry = createTestGeometry();
    const score = createScore({ angleColumns: 256, radialRows: 64 });
    const scorePolar = { angleTurns: 0.25, radialT: 0.5 };

    stampBrush(score, geometry, scorePolar, 12, {
      tool: "paint",
      colourIndex: 2
    });
    assert.ok(score.nonEmptyIndices.size > 0);

    stampBrush(score, geometry, scorePolar, 12, {
      tool: "erase",
      colourIndex: 2
    });

    assert.equal(score.nonEmptyIndices.size, 0);
  });

  it("wraps stamp coverage across the angle seam", () => {
    const geometry = createTestGeometry();
    const score = createScore({ angleColumns: 64, radialRows: 32 });

    stampBrush(
      score,
      geometry,
      { angleTurns: 0.995, radialT: 0.5 },
      20,
      { tool: "paint", colourIndex: 4 }
    );

    const columns = new Set(
      Array.from(score.nonEmptyIndices).map((index) => index % score.angleColumns)
    );

    assert.equal(columns.has(0), true);
    assert.equal(columns.has(63), true);
  });

  it("matches conservative reference stamping for representative edge cases", () => {
    const fixtures = [
      {
        scorePolar: { angleTurns: 0.25, radialT: 0.5 },
        brushRadius: 12,
        editMode: { tool: "paint", colourIndex: 3 }
      },
      {
        scorePolar: { angleTurns: 0.995, radialT: 0.5 },
        brushRadius: 20,
        editMode: { tool: "paint", colourIndex: 4 }
      },
      {
        scorePolar: { angleTurns: 0.4, radialT: 0.01 },
        brushRadius: 18,
        editMode: { tool: "paint", colourIndex: 2 }
      },
      {
        scorePolar: { angleTurns: 0.65, radialT: 0.99 },
        brushRadius: 18,
        editMode: { tool: "paint", colourIndex: 5 }
      },
      {
        scoreOptions: { angleColumns: 32, radialRows: 20 },
        scorePolar: { angleTurns: 0.1, radialT: 0.5 },
        brushRadius: 340,
        editMode: { tool: "paint", colourIndex: 1 }
      },
      {
        scorePolar: { angleTurns: 0.3, radialT: 0.45 },
        brushRadius: 28,
        editMode: { tool: "erase", colourIndex: 2 },
        setup(score) {
          stampBrushReference(
            score,
            createTestGeometry(),
            { angleTurns: 0.3, radialT: 0.45 },
            30,
            { tool: "paint", colourIndex: 2 }
          );
        }
      },
      {
        scorePolar: { angleTurns: 0.75, radialT: 0.35 },
        brushRadius: 16,
        editMode: { tool: "paint", colourIndex: 0 }
      }
    ];

    for (const fixture of fixtures) {
      assertBrushMatchesReference(fixture);
    }
  });
});
