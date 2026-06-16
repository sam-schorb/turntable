import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createInitialTransportState,
  createTransport,
  getTransportSnapshot,
  requestPause,
  requestResume,
  requestStop,
  setPlaying,
  setTargetGlobalSpeed,
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
});
