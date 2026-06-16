import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  appendDirtyRegion,
  createDirtyRegion,
  createFullScoreDirtyRegion,
  mergeDirtyRegions
} from "../src/dirty-regions.js";
import { createScore } from "../src/score.js";

describe("dirty regions", () => {
  it("creates compact non-wrapping regions from affected cells", () => {
    const score = createScore({ angleColumns: 64, radialRows: 16 });
    const region = createDirtyRegion(
      score,
      [
        { angleColumn: 10, radialRow: 2 },
        { angleColumn: 12, radialRow: 5 }
      ],
      "paint"
    );

    assert.deepEqual(region, {
      editType: "paint",
      minAngleColumn: 10,
      maxAngleColumn: 12,
      wraps: false,
      minRadialRow: 2,
      maxRadialRow: 5,
      scoreVersion: 0,
      fullScore: false
    });
  });

  it("marks regions that wrap across the angle seam", () => {
    const score = createScore({ angleColumns: 64, radialRows: 16 });
    const region = createDirtyRegion(
      score,
      [
        { angleColumn: 63, radialRow: 4 },
        { angleColumn: 0, radialRow: 4 },
        { angleColumn: 1, radialRow: 5 }
      ],
      "erase"
    );

    assert.equal(region.wraps, true);
    assert.equal(region.minAngleColumn, 63);
    assert.equal(region.maxAngleColumn, 1);
    assert.equal(region.minRadialRow, 4);
    assert.equal(region.maxRadialRow, 5);
  });

  it("creates full-score dirty regions for clear", () => {
    const score = createScore({ angleColumns: 64, radialRows: 16 });
    const region = createFullScoreDirtyRegion(score, "clear");

    assert.equal(region.fullScore, true);
    assert.equal(region.minAngleColumn, 0);
    assert.equal(region.maxAngleColumn, 63);
    assert.equal(region.minRadialRow, 0);
    assert.equal(region.maxRadialRow, 15);
  });

  it("appends only real regions", () => {
    const queue = [];
    const score = createScore({ angleColumns: 64, radialRows: 16 });
    const region = createFullScoreDirtyRegion(score, "clear");

    appendDirtyRegion(queue, null);
    appendDirtyRegion(queue, region);

    assert.deepEqual(queue, [region]);
  });

  it("merges frame dirty regions into one safe publication region", () => {
    const score = createScore({ angleColumns: 64, radialRows: 16 });
    const first = createDirtyRegion(
      score,
      [
        { angleColumn: 62, radialRow: 2 },
        { angleColumn: 63, radialRow: 3 }
      ],
      "paint"
    );
    const second = createDirtyRegion(
      score,
      [
        { angleColumn: 0, radialRow: 4 },
        { angleColumn: 1, radialRow: 6 }
      ],
      "paint"
    );
    const merged = mergeDirtyRegions(score, [first, second]);

    assert.equal(merged.length, 1);
    assert.deepEqual(merged[0], {
      editType: "paint",
      minAngleColumn: 62,
      maxAngleColumn: 1,
      wraps: true,
      minRadialRow: 2,
      maxRadialRow: 6,
      scoreVersion: 0,
      fullScore: false
    });
  });

  it("keeps full-score dirty publications full-score after merging", () => {
    const score = createScore({ angleColumns: 64, radialRows: 16 });
    const clear = createFullScoreDirtyRegion(score, "clear");
    const paint = createDirtyRegion(
      score,
      [{ angleColumn: 10, radialRow: 2 }],
      "paint"
    );
    const merged = mergeDirtyRegions(score, [clear, paint]);

    assert.equal(merged.length, 1);
    assert.equal(merged[0].fullScore, true);
    assert.equal(merged[0].editType, "mixed");
    assert.equal(merged[0].minAngleColumn, 0);
    assert.equal(merged[0].maxAngleColumn, 63);
    assert.equal(merged[0].minRadialRow, 0);
    assert.equal(merged[0].maxRadialRow, 15);
  });
});
