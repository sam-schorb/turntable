import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createDiscGeometry } from "../src/geometry.js";
import {
  beginPlatterGesture,
  cancelPlatterGesture,
  createPlatterGestureController,
  endPlatterGesture,
  getPlatterGestureEventSamples,
  getPlatterGestureState,
  updatePlatterGesture
} from "../src/platter-gesture.js";
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

function assertNearlyEqual(actual, expected, tolerance = 1e-9) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${actual} to be within ${tolerance} of ${expected}`
  );
}

function createController(options = {}) {
  const transport = options.transport || createTransport(options.transportConfig);
  const geometry = options.geometry || createDiscGeometry({ width: 400, height: 400 });
  const canvas = options.canvas || new FakeCanvas();

  return createPlatterGestureController({
    transport,
    canvas,
    getGeometry: options.getGeometry || (() => geometry)
  });
}

function pointerAt(geometry, angleTurns, radius, pointerId = 1) {
  const angleRadians = angleTurns * Math.PI * 2;

  return {
    pointerId,
    clientX: geometry.center.x + Math.cos(angleRadians) * radius,
    clientY: geometry.center.y + Math.sin(angleRadians) * radius
  };
}

function createPointerEvent({
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

describe("platter gesture controller", () => {
  it("begins a grab from a pointer inside the visible disc", () => {
    const geometry = createDiscGeometry({ width: 400, height: 400 });
    const controller = createController({ geometry });
    const pointer = pointerAt(
      geometry,
      0.25,
      (geometry.innerPlayableRadius + geometry.outerRadius) / 2
    );
    const result = beginPlatterGesture(controller, pointer, 0);

    assert.equal(result.started, true);
    assert.equal(result.pointerId, 1);
    assert.equal(result.handGrabActive, true);
    assert.equal(result.motionSource, "hand");
    assert.equal(getPlatterGestureState(controller).activePointerId, 1);
  });

  it("ignores pointers outside the visible platter", () => {
    const geometry = createDiscGeometry({ width: 400, height: 400 });
    const controller = createController({ geometry });
    const pointer = pointerAt(geometry, 0.25, geometry.outerRadius + 1);
    const result = beginPlatterGesture(controller, pointer, 0);

    assert.equal(result.started, false);
    assert.equal(result.reason, "outside_platter");
    assert.equal(controller.transport.handGrabActive, false);
    assert.equal(getPlatterGestureState(controller).active, false);
  });

  it("leaves the central control area available for the play button", () => {
    const geometry = createDiscGeometry({ width: 400, height: 400 });
    const controller = createController({ geometry });
    const pointer = pointerAt(geometry, 0.25, geometry.hubRadius * 0.5);
    const result = beginPlatterGesture(controller, pointer, 0);

    assert.equal(result.started, false);
    assert.equal(result.reason, "central_control");
    assert.equal(controller.transport.handGrabActive, false);
  });

  it("allows both playable and non-playable visible disc regions to grab", () => {
    const geometry = createDiscGeometry({ width: 400, height: 400 });
    const playable = createController({ geometry });
    const nonPlayable = createController({ geometry });
    const playablePointer = pointerAt(
      geometry,
      0.25,
      (geometry.innerPlayableRadius + geometry.outerRadius) / 2
    );
    const nonPlayablePointer = pointerAt(
      geometry,
      0.25,
      (geometry.hubRadius + geometry.innerPlayableRadius) / 2
    );

    assert.equal(beginPlatterGesture(playable, playablePointer, 0).started, true);
    assert.equal(
      beginPlatterGesture(nonPlayable, nonPlayablePointer, 0).started,
      true
    );
  });

  it("pointer move updates transport phase and signed speed", () => {
    const geometry = createDiscGeometry({ width: 400, height: 400 });
    const controller = createController({
      geometry,
      transportConfig: { defaultPhaseTurns: 0.5 }
    });
    const radius = (geometry.innerPlayableRadius + geometry.outerRadius) / 2;

    beginPlatterGesture(controller, pointerAt(geometry, 0.25, radius), 0);
    const result = updatePlatterGesture(
      controller,
      pointerAt(geometry, 0.125, radius),
      1
    );

    assert.equal(result.updated, true);
    assertNearlyEqual(controller.transport.phaseTurns, 0.625);
    assertNearlyEqual(controller.transport.actualGlobalSpeed, 1);
    assert.equal(result.handGrabActive, true);
  });

  it("larger angular movement over the same time creates higher speed", () => {
    const geometry = createDiscGeometry({ width: 400, height: 400 });
    const radius = (geometry.innerPlayableRadius + geometry.outerRadius) / 2;
    const slow = createController({ geometry });
    const fast = createController({ geometry });

    beginPlatterGesture(slow, pointerAt(geometry, 0.25, radius), 0);
    updatePlatterGesture(slow, pointerAt(geometry, 0.125, radius), 1);
    beginPlatterGesture(fast, pointerAt(geometry, 0.25, radius), 0);
    updatePlatterGesture(fast, pointerAt(geometry, 0, radius), 1);

    assert.ok(
      Math.abs(fast.transport.actualGlobalSpeed) >
        Math.abs(slow.transport.actualGlobalSpeed)
    );
    assertNearlyEqual(slow.transport.actualGlobalSpeed, 1);
    assertNearlyEqual(fast.transport.actualGlobalSpeed, 2);
  });

  it("ignores updates from pointers that do not own the active grab", () => {
    const geometry = createDiscGeometry({ width: 400, height: 400 });
    const controller = createController({ geometry });
    const radius = (geometry.innerPlayableRadius + geometry.outerRadius) / 2;

    beginPlatterGesture(controller, pointerAt(geometry, 0.25, radius, 1), 0);
    const result = updatePlatterGesture(
      controller,
      pointerAt(geometry, 0.125, radius, 2),
      1
    );

    assert.equal(result.updated, false);
    assert.equal(result.reason, "inactive_pointer");
    assertNearlyEqual(controller.transport.phaseTurns, 0);
  });

  it("end updates the final pointer angle before releasing the transport grab", () => {
    const geometry = createDiscGeometry({ width: 400, height: 400 });
    const controller = createController({ geometry });
    const radius = (geometry.innerPlayableRadius + geometry.outerRadius) / 2;

    beginPlatterGesture(controller, pointerAt(geometry, 0.25, radius), 0);
    const result = endPlatterGesture(
      controller,
      pointerAt(geometry, 0.125, radius),
      1
    );

    assert.equal(result.ended, true);
    assert.equal(result.handGrabActive, false);
    assert.equal(controller.transport.actualGlobalSpeed, 0);
    assertNearlyEqual(controller.transport.phaseTurns, 0.125);
    assert.equal(getPlatterGestureState(controller).active, false);
  });

  it("cancel releases the transport without applying a final pointer update", () => {
    const geometry = createDiscGeometry({ width: 400, height: 400 });
    const controller = createController({ geometry });
    const radius = (geometry.innerPlayableRadius + geometry.outerRadius) / 2;

    beginPlatterGesture(controller, pointerAt(geometry, 0.25, radius), 0);
    updatePlatterGesture(controller, pointerAt(geometry, 0.125, radius), 1);
    const phaseBeforeCancel = controller.transport.phaseTurns;
    const result = cancelPlatterGesture(
      controller,
      pointerAt(geometry, 0, radius),
      1.5
    );

    assert.equal(result.cancelled, true);
    assert.equal(result.handGrabActive, false);
    assert.equal(controller.transport.actualGlobalSpeed, 0);
    assertNearlyEqual(controller.transport.phaseTurns, phaseBeforeCancel);
  });

  it("collects coalesced pointer samples and includes the final event", () => {
    const canvas = new FakeCanvas();
    const event = createPointerEvent({
      clientX: 240,
      clientY: 80,
      timeStamp: 30,
      coalesced: [
        { clientX: 210, clientY: 80, timeStamp: 10 },
        { clientX: 220, clientY: 80, timeStamp: 20 }
      ]
    });
    const samples = getPlatterGestureEventSamples(event, canvas, 0.03);

    assert.deepEqual(
      samples.map((sample) => [sample.clientX, sample.clientY, sample.timeSeconds]),
      [
        [210, 80, 0.01],
        [220, 80, 0.02],
        [240, 80, 0.03]
      ]
    );
  });
});
