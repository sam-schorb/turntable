import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  beginPlatterGrab,
  cancelPlatterGrab,
  createInitialTransportState,
  createTransport,
  endPlatterGrab,
  getTransportSnapshot,
  requestPause,
  requestResume,
  requestStop,
  setPlaying,
  setTargetGlobalSpeed,
  updatePlatterGrab,
  updateTransport
} from "../src/transport.js";

function assertNearlyEqual(actual, expected, tolerance = 1e-9) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${actual} to be within ${tolerance} of ${expected}`
  );
}

describe("signed transport phase model", () => {
  it("exposes idle platter and motor metadata without changing defaults", () => {
    const transport = createTransport();
    const snapshot = getTransportSnapshot(transport, 0);

    assert.equal(snapshot.targetGlobalSpeed, 1);
    assert.equal(snapshot.motorTargetSpeed, 1);
    assert.equal(snapshot.motorEnabled, false);
    assert.equal(snapshot.handGrabActive, false);
    assert.equal(snapshot.canStartVoices, false);
    assert.equal(snapshot.motionSource, "idle");
    assert.equal(snapshot.isPlaying, false);
    assert.equal(snapshot.isPaused, true);
    assert.equal(snapshot.actualGlobalSpeed, 0);
    assertNearlyEqual(snapshot.phaseTurns, 0);
  });

  it("exposes motor playback as voice-start-capable platter motion", () => {
    const transport = createTransport({ defaultIsPlaying: true });
    const snapshot = getTransportSnapshot(transport, 0);

    assert.equal(snapshot.targetGlobalSpeed, 1);
    assert.equal(snapshot.motorTargetSpeed, 1);
    assert.equal(snapshot.motorEnabled, true);
    assert.equal(snapshot.handGrabActive, false);
    assert.equal(snapshot.canStartVoices, true);
    assert.equal(snapshot.motionSource, "motor");
    assert.equal(snapshot.isPlaying, true);
    assert.equal(snapshot.isPaused, false);
    assert.equal(snapshot.actualGlobalSpeed, 1);
  });

  it("exposes platter and motor fields in the initial transport state", () => {
    const state = createInitialTransportState();

    assert.equal(state.motorTargetSpeed, 1);
    assert.equal(state.motorEnabled, false);
    assert.equal(state.handGrabActive, false);
    assert.equal(state.canStartVoices, false);
    assert.equal(state.motionSource, "idle");
    assert.equal(state.targetGlobalSpeed, 1);
    assert.equal(state.isPlaying, false);
    assert.equal(state.isPaused, true);
  });

  it("clamps target speed to the configured signed range", () => {
    const transport = createTransport();

    setTargetGlobalSpeed(transport, 12);
    assert.equal(transport.targetGlobalSpeed, 4);
    assert.equal(transport.motorTargetSpeed, 4);

    setTargetGlobalSpeed(transport, -12);
    assert.equal(transport.targetGlobalSpeed, -4);
    assert.equal(transport.motorTargetSpeed, -4);
  });

  it("+1 speed advances one full phase turn over eight seconds", () => {
    const transport = createTransport({ defaultIsPlaying: true });
    const snapshot = getTransportSnapshot(transport, 8);

    assert.equal(snapshot.actualGlobalSpeed, 1);
    assertNearlyEqual(snapshot.phaseTurns, 0);
  });

  it("positive speed increases phase", () => {
    const transport = createTransport({ defaultIsPlaying: true });

    updateTransport(transport, 0);
    updateTransport(transport, 2);

    assertNearlyEqual(transport.phaseTurns, 0.25);
  });

  it("negative speed decreases phase and wraps below zero", () => {
    const transport = createTransport({
      defaultPhaseTurns: 0.25,
      defaultTargetGlobalSpeed: -1,
      defaultIsPlaying: true
    });

    updateTransport(transport, 0);
    updateTransport(transport, 4);

    assertNearlyEqual(transport.phaseTurns, 0.75);
  });

  it("zero speed freezes phase while playing", () => {
    const transport = createTransport({
      defaultPhaseTurns: 0.4,
      defaultTargetGlobalSpeed: 0,
      defaultIsPlaying: true
    });

    updateTransport(transport, 5);

    assertNearlyEqual(transport.phaseTurns, 0.4);
  });

  it("pause preserves target speed while actual speed decelerates to zero", () => {
    const transport = createTransport();

    setTargetGlobalSpeed(transport, 2);
    requestResume(transport, 0);
    updateTransport(transport, 0.35);
    requestPause(transport, 1);
    updateTransport(transport, 1.25);

    assert.equal(transport.targetGlobalSpeed, 2);
    assert.equal(transport.motorTargetSpeed, 2);
    assert.equal(transport.isPaused, true);
    assert.equal(transport.motorEnabled, false);
    assert.equal(transport.canStartVoices, false);
    assert.equal(transport.motionSource, "motor");
    assert.equal(transport.isRamping, true);
    assertNearlyEqual(transport.actualGlobalSpeed, 1);

    updateTransport(transport, 1.5);

    assert.equal(transport.targetGlobalSpeed, 2);
    assert.equal(transport.motorTargetSpeed, 2);
    assert.equal(transport.actualGlobalSpeed, 0);
    assert.equal(transport.isRamping, false);
    assert.equal(transport.canStartVoices, false);
    assert.equal(transport.motionSource, "idle");
  });

  it("repeated updates with the same timestamp do not corrupt phase", () => {
    const transport = createTransport();

    setPlaying(transport, true, 10);
    updateTransport(transport, 10);
    updateTransport(transport, 10);

    assertNearlyEqual(transport.phaseTurns, 0);
  });

  it("resume accelerates actual speed from zero to the current target", () => {
    const transport = createTransport();

    setTargetGlobalSpeed(transport, -2);
    requestResume(transport, 0);
    updateTransport(transport, 0.175);

    assert.equal(transport.targetGlobalSpeed, -2);
    assert.equal(transport.motorTargetSpeed, -2);
    assert.equal(transport.motorEnabled, true);
    assert.equal(transport.canStartVoices, true);
    assert.equal(transport.motionSource, "motor");
    assert.equal(transport.isPlaying, true);
    assert.equal(transport.isPaused, false);
    assert.equal(transport.isRamping, true);
    assertNearlyEqual(transport.actualGlobalSpeed, -1);

    updateTransport(transport, 0.35);

    assert.equal(transport.actualGlobalSpeed, -2);
    assert.equal(transport.isRamping, false);
  });

  it("speed changes while paused preserve the target without spinning the disc", () => {
    const transport = createTransport();

    setTargetGlobalSpeed(transport, -3);
    updateTransport(transport, 5);

    assert.equal(transport.targetGlobalSpeed, -3);
    assert.equal(transport.motorTargetSpeed, -3);
    assert.equal(transport.motorEnabled, false);
    assert.equal(transport.canStartVoices, false);
    assert.equal(transport.motionSource, "idle");
    assert.equal(transport.actualGlobalSpeed, 0);
    assertNearlyEqual(transport.phaseTurns, 0);
  });

  it("pause ramp contributes decreasing visual phase instead of an instant stop", () => {
    const transport = createTransport({
      defaultIsPlaying: true,
      defaultTargetGlobalSpeed: 2
    });

    updateTransport(transport, 0);
    updateTransport(transport, 1);
    requestPause(transport, 1);
    updateTransport(transport, 1.25);
    const midRampPhase = transport.phaseTurns;
    updateTransport(transport, 1.5);
    const stoppedPhase = transport.phaseTurns;
    updateTransport(transport, 2.5);

    assert.ok(midRampPhase > 0.25);
    assert.ok(stoppedPhase > midRampPhase);
    assertNearlyEqual(transport.phaseTurns, stoppedPhase);
  });

  it("stop uses the ramped pause path without resetting position", () => {
    const transport = createTransport({
      defaultIsPlaying: true,
      defaultTargetGlobalSpeed: 2
    });

    updateTransport(transport, 0);
    updateTransport(transport, 1);
    requestStop(transport, 1);
    const rampStartPhase = transport.phaseTurns;

    updateTransport(transport, 1.25);
    const midRampPhase = transport.phaseTurns;
    updateTransport(transport, 1.5);
    const stoppedPhase = transport.phaseTurns;
    updateTransport(transport, 2.5);

    assert.equal(transport.targetGlobalSpeed, 2);
    assert.equal(transport.motorTargetSpeed, 2);
    assert.equal(transport.actualGlobalSpeed, 0);
    assert.equal(transport.motorEnabled, false);
    assert.equal(transport.canStartVoices, false);
    assert.equal(transport.motionSource, "idle");
    assert.equal(transport.isPlaying, false);
    assert.equal(transport.isPaused, true);
    assert.equal(transport.isRamping, false);
    assertNearlyEqual(rampStartPhase, 0.25);
    assert.ok(midRampPhase > rampStartPhase);
    assert.ok(stoppedPhase > midRampPhase);
    assertNearlyEqual(transport.phaseTurns, stoppedPhase);
  });

  it("grab while motor stopped changes the real platter phase and snapshot source", () => {
    const transport = createTransport({ defaultPhaseTurns: 0.25 });

    beginPlatterGrab(transport, 0.25, 0);
    updatePlatterGrab(transport, 0.125, 1);
    const snapshot = getTransportSnapshot(transport, 1);

    assertNearlyEqual(snapshot.phaseTurns, 0.375);
    assert.equal(snapshot.handGrabActive, true);
    assert.equal(snapshot.motionSource, "hand");
    assert.equal(snapshot.canStartVoices, true);
    assert.equal(snapshot.isPaused, true);
  });

  it("snapshots expose hand motion samples for reader sweep analysis", () => {
    const transport = createTransport({ defaultPhaseTurns: 0.25 });

    beginPlatterGrab(transport, 0.25, 0);
    updatePlatterGrab(transport, 0.125, 1);
    const snapshot = getTransportSnapshot(transport, 1);

    assert.equal(snapshot.timeSeconds, 1);
    assert.equal(snapshot.handGrabActive, true);
    assert.equal(snapshot.motionSamples.length, 2);
    assertNearlyEqual(snapshot.motionSamples[0].unwrappedPhaseTurns, 0.25);
    assertNearlyEqual(snapshot.motionSamples[1].unwrappedPhaseTurns, 0.375);
    assertNearlyEqual(snapshot.unwrappedPhaseTurns, 0.375);

    endPlatterGrab(transport, 1);
    const released = getTransportSnapshot(transport, 1);

    assert.equal(released.handGrabActive, false);
    assert.deepEqual(released.motionSamples, []);
  });

  it("grab while motor stopped creates non-zero signed platter speed", () => {
    const transport = createTransport();

    beginPlatterGrab(transport, 0.25, 0);
    updatePlatterGrab(transport, 0.125, 1);

    assertNearlyEqual(transport.actualGlobalSpeed, 1);
  });

  it("faster hand movement creates larger platter speed", () => {
    const slow = createTransport();
    const fast = createTransport();

    beginPlatterGrab(slow, 0.25, 0);
    updatePlatterGrab(slow, 0.125, 1);
    beginPlatterGrab(fast, 0.25, 0);
    updatePlatterGrab(fast, 0.125, 0.5);

    assert.ok(
      Math.abs(fast.actualGlobalSpeed) > Math.abs(slow.actualGlobalSpeed)
    );
    assertNearlyEqual(slow.actualGlobalSpeed, 1);
    assertNearlyEqual(fast.actualGlobalSpeed, 2);
  });

  it("slower hand movement creates smaller platter speed", () => {
    const largerMove = createTransport();
    const smallerMove = createTransport();

    beginPlatterGrab(largerMove, 0.25, 0);
    updatePlatterGrab(largerMove, 0.125, 1);
    beginPlatterGrab(smallerMove, 0.25, 0);
    updatePlatterGrab(smallerMove, 0.1875, 1);

    assert.ok(
      Math.abs(smallerMove.actualGlobalSpeed) <
        Math.abs(largerMove.actualGlobalSpeed)
    );
    assertNearlyEqual(smallerMove.actualGlobalSpeed, 0.5);
  });

  it("reverse drag creates negative platter speed", () => {
    const transport = createTransport();

    beginPlatterGrab(transport, 0.25, 0);
    updatePlatterGrab(transport, 0.375, 1);

    assertNearlyEqual(transport.actualGlobalSpeed, -1);
  });

  it("uses phaseDeltaTurns = -pointerDeltaTurns for visible point tracking", () => {
    const transport = createTransport({ defaultPhaseTurns: 0.4 });

    beginPlatterGrab(transport, 0.1, 0);
    updatePlatterGrab(transport, 0.2, 1);

    assertNearlyEqual(transport.phaseTurns, 0.3);
    assertNearlyEqual(transport.actualGlobalSpeed, -0.8);
  });

  it("seam-crossing hand movement unwraps smoothly", () => {
    const transport = createTransport({ defaultPhaseTurns: 0.5 });

    beginPlatterGrab(transport, 0.98, 0);
    updatePlatterGrab(transport, 0.02, 1);

    assertNearlyEqual(transport.phaseTurns, 0.46);
    assertNearlyEqual(transport.actualGlobalSpeed, -0.32);
    assertNearlyEqual(transport.handUnwrappedAngleTurns, 1.02);
  });

  it("release while motor stopped freezes phase and speed", () => {
    const transport = createTransport();

    beginPlatterGrab(transport, 0.25, 0);
    updatePlatterGrab(transport, 0.125, 1);
    const releasePhase = transport.phaseTurns;

    endPlatterGrab(transport, 1);
    updateTransport(transport, 3);

    assert.equal(transport.handGrabActive, false);
    assert.equal(transport.actualGlobalSpeed, 0);
    assert.equal(transport.canStartVoices, false);
    assert.equal(transport.motionSource, "idle");
    assertNearlyEqual(transport.phaseTurns, releasePhase);
  });

  it("release while motor enabled continues motor motion from dragged phase", () => {
    const transport = createTransport({
      defaultIsPlaying: true,
      defaultTargetGlobalSpeed: 2
    });

    updateTransport(transport, 0);
    updateTransport(transport, 1);
    beginPlatterGrab(transport, 0.25, 1);
    updatePlatterGrab(transport, 0.125, 2);
    const draggedPhase = transport.phaseTurns;

    endPlatterGrab(transport, 2);
    updateTransport(transport, 3);

    assert.equal(transport.motorEnabled, true);
    assert.equal(transport.motionSource, "motor");
    assert.equal(transport.actualGlobalSpeed, 2);
    assertNearlyEqual(transport.phaseTurns, draggedPhase + 0.25);
  });

  it("target speed is unchanged by hand dragging", () => {
    const transport = createTransport();

    setTargetGlobalSpeed(transport, 3);
    beginPlatterGrab(transport, 0.25, 0);
    updatePlatterGrab(transport, 0.125, 1);
    endPlatterGrab(transport, 1);

    assert.equal(transport.targetGlobalSpeed, 3);
    assert.equal(transport.motorTargetSpeed, 3);
    assert.equal(transport.actualGlobalSpeed, 0);
  });

  it("target changes during grab do not overwrite hand-controlled speed", () => {
    const transport = createTransport({ defaultIsPlaying: true });

    beginPlatterGrab(transport, 0.25, 0);
    updatePlatterGrab(transport, 0.125, 1);
    setTargetGlobalSpeed(transport, 3, 1);

    assert.equal(transport.motorTargetSpeed, 3);
    assertNearlyEqual(transport.actualGlobalSpeed, 1);
  });

  it("pause during grab leaves hand in control and releases to idle", () => {
    const transport = createTransport({
      defaultIsPlaying: true,
      defaultTargetGlobalSpeed: 2
    });

    beginPlatterGrab(transport, 0.25, 0);
    updatePlatterGrab(transport, 0.125, 1);
    requestPause(transport, 1);

    assert.equal(transport.handGrabActive, true);
    assert.equal(transport.motorEnabled, false);
    assert.equal(transport.motionSource, "hand");
    assert.equal(transport.canStartVoices, true);
    assertNearlyEqual(transport.actualGlobalSpeed, 1);

    endPlatterGrab(transport, 1);

    assert.equal(transport.motionSource, "idle");
    assert.equal(transport.canStartVoices, false);
    assert.equal(transport.actualGlobalSpeed, 0);
  });

  it("resume during grab arms motor without overriding hand-controlled speed", () => {
    const transport = createTransport();

    setTargetGlobalSpeed(transport, 2);
    beginPlatterGrab(transport, 0.25, 0);
    updatePlatterGrab(transport, 0.125, 1);
    requestResume(transport, 1);

    assert.equal(transport.handGrabActive, true);
    assert.equal(transport.motorEnabled, true);
    assert.equal(transport.motionSource, "hand");
    assertNearlyEqual(transport.actualGlobalSpeed, 1);

    endPlatterGrab(transport, 1);

    assert.equal(transport.motionSource, "motor");
    assert.equal(transport.canStartVoices, true);
    assert.equal(transport.actualGlobalSpeed, 2);
  });

  it("canStartVoices stays true during an active near-zero-speed grab", () => {
    const transport = createTransport();

    beginPlatterGrab(transport, 0.25, 0);
    updatePlatterGrab(transport, 0.25, 1);

    assert.equal(transport.handGrabActive, true);
    assert.equal(transport.canStartVoices, true);
    assert.equal(transport.motionSource, "hand");
    assert.equal(transport.actualGlobalSpeed, 0);
  });

  it("canStartVoices becomes false after release when motor is off", () => {
    const transport = createTransport();

    beginPlatterGrab(transport, 0.25, 0);
    updatePlatterGrab(transport, 0.125, 1);
    endPlatterGrab(transport, 1);

    assert.equal(transport.handGrabActive, false);
    assert.equal(transport.motorEnabled, false);
    assert.equal(transport.canStartVoices, false);
  });

  it("cancel while motor stopped behaves like release without resetting phase", () => {
    const transport = createTransport();

    beginPlatterGrab(transport, 0.25, 0);
    updatePlatterGrab(transport, 0.125, 1);
    const draggedPhase = transport.phaseTurns;

    cancelPlatterGrab(transport, 1);

    assert.equal(transport.handGrabActive, false);
    assert.equal(transport.actualGlobalSpeed, 0);
    assertNearlyEqual(transport.phaseTurns, draggedPhase);
  });

  it("repeated same-angle grab updates do not corrupt phase", () => {
    const transport = createTransport({ defaultPhaseTurns: 0.4 });

    beginPlatterGrab(transport, 0.25, 0);
    updatePlatterGrab(transport, 0.25, 1);
    updatePlatterGrab(transport, 0.25, 2);

    assertNearlyEqual(transport.phaseTurns, 0.4);
    assert.equal(transport.actualGlobalSpeed, 0);
  });

  it("same-timestamp grab updates do not produce infinite velocity", () => {
    const transport = createTransport();

    beginPlatterGrab(transport, 0.25, 1);
    updatePlatterGrab(transport, 0.125, 1);
    updatePlatterGrab(transport, 0, 1);

    assert.equal(Number.isFinite(transport.actualGlobalSpeed), true);
    assertNearlyEqual(transport.actualGlobalSpeed, 0);
    assertNearlyEqual(transport.phaseTurns, 0.25);
  });

  it("extreme hand velocity clamps to configured speed limits", () => {
    const transport = createTransport();

    beginPlatterGrab(transport, 0.5, 0);
    updatePlatterGrab(transport, 0, 0.001);

    assert.equal(transport.actualGlobalSpeed, 4);
  });

  it("tiny angle jitter produces near-zero hand speed", () => {
    const transport = createTransport({ defaultPhaseTurns: 0.5 });

    beginPlatterGrab(transport, 0.5, 0);
    updatePlatterGrab(transport, 0.50000001, 1);

    assert.equal(transport.actualGlobalSpeed, 0);
    assertNearlyEqual(transport.phaseTurns, 0.5, 0.000001);
  });
});
