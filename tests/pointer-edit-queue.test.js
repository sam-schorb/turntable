import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BRUSH_CONFIG } from "../src/config.js";
import { createDiscGeometry } from "../src/geometry.js";
import { beginStroke, createPaintController } from "../src/paint.js";
import {
  createPointerEditQueue,
  enqueuePointerEnd,
  enqueuePointerMove,
  getPointerEventSamples,
  processPointerEditQueue
} from "../src/pointer-edit-queue.js";
import { createScore } from "../src/score.js";
import { createTransport } from "../src/transport.js";

class FakeCanvas {
  getBoundingClientRect() {
    return {
      left: 0,
      top: 0,
      width: 400,
      height: 400
    };
  }
}

function createController() {
  const score = createScore({ angleColumns: 512, radialRows: 128 });
  const transport = createTransport();
  const geometry = createDiscGeometry({ width: 400, height: 400 });
  const canvas = new FakeCanvas();

  return createPaintController({
    score,
    transport,
    geometry,
    canvas,
    brushConfig: {
      ...BRUSH_CONFIG,
      minRadiusRatio: 0.018,
      maxRadiusRatio: 0.08
    }
  });
}

function pointerEvent({
  pointerId = 1,
  clientX = 200,
  clientY = 80,
  timeStamp = 0,
  coalesced = []
} = {}) {
  return {
    pointerId,
    clientX,
    clientY,
    timeStamp,
    getCoalescedEvents() {
      return coalesced;
    }
  };
}

describe("pointer edit queue", () => {
  it("collects coalesced pointer samples and includes the final event", () => {
    const canvas = new FakeCanvas();
    const event = pointerEvent({
      clientX: 240,
      clientY: 80,
      timeStamp: 30,
      coalesced: [
        { clientX: 210, clientY: 80, timeStamp: 10 },
        { clientX: 220, clientY: 80, timeStamp: 20 }
      ]
    });
    const samples = getPointerEventSamples(event, canvas, 0.03);

    assert.deepEqual(
      samples.map((sample) => [sample.clientX, sample.clientY, sample.timeSeconds]),
      [
        [210, 80, 0.01],
        [220, 80, 0.02],
        [240, 80, 0.03]
      ]
    );
  });

  it("processes queued moves against an active live stroke", () => {
    const controller = createController();
    const queue = createPointerEditQueue();

    assert.equal(
      beginStroke(controller, { pointerId: 1, clientX: 200, clientY: 80 }, 0)
        .started,
      true
    );

    enqueuePointerMove(queue, [
      {
        pointerId: 1,
        clientX: 212,
        clientY: 80,
        canvas: controller.canvas,
        timeSeconds: 0.01
      },
      {
        pointerId: 1,
        clientX: 232,
        clientY: 80,
        canvas: controller.canvas,
        timeSeconds: 0.02
      }
    ]);

    const result = processPointerEditQueue(queue, controller, 0.03);

    assert.equal(result.processed, 2);
    assert.equal(result.hasBacklog, false);
    assert.ok(result.mutationCount > 0);
    assert.ok(controller.score.nonEmptyIndices.size > 0);
    assert.equal(controller.activeStroke.pointerId, 1);
  });

  it("queues pointerup so stroke ending stays out of the event handler", () => {
    const controller = createController();
    const queue = createPointerEditQueue();

    assert.equal(
      beginStroke(controller, { pointerId: 1, clientX: 200, clientY: 80 }, 0)
        .started,
      true
    );

    enqueuePointerEnd(queue, [
      {
        pointerId: 1,
        clientX: 224,
        clientY: 80,
        canvas: controller.canvas,
        timeSeconds: 0.02
      }
    ]);

    assert.notEqual(controller.activeStroke, null);

    const result = processPointerEditQueue(queue, controller, 0.03);

    assert.equal(result.ended, 1);
    assert.equal(controller.activeStroke, null);
  });

  it("respects a per-frame operation budget", () => {
    const controller = createController();
    const queue = createPointerEditQueue({ maxOperationsPerFrame: 1 });

    assert.equal(
      beginStroke(controller, { pointerId: 1, clientX: 200, clientY: 80 }, 0)
        .started,
      true
    );

    enqueuePointerMove(queue, [
      {
        pointerId: 1,
        clientX: 210,
        clientY: 80,
        canvas: controller.canvas,
        timeSeconds: 0.01
      },
      {
        pointerId: 1,
        clientX: 230,
        clientY: 80,
        canvas: controller.canvas,
        timeSeconds: 0.02
      }
    ]);

    const first = processPointerEditQueue(queue, controller, 0.03);
    const second = processPointerEditQueue(queue, controller, 0.04);

    assert.equal(first.processed, 1);
    assert.equal(first.hasBacklog, true);
    assert.equal(second.processed, 1);
    assert.equal(second.hasBacklog, false);
  });
});
