import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AUDIO_CONFIG } from "../src/config.js";
import { createSampleManager, getSampleSlot } from "../src/sample-manager.js";
import {
  createVoiceManager,
  getVoiceState,
  recoverVoicesFromCurrentDescriptors,
  reconcileDescriptors
} from "../src/voice-manager.js";

function createReadyAudioEngine() {
  return {
    status: "ready",
    config: AUDIO_CONFIG,
    postedMessages: [],
    workletNode: {
      port: {
        postMessage() {}
      }
    }
  };
}

function createLoadedSampleManager(loadedSlots = [0, 1, 2, 3, 4, 5]) {
  const manager = createSampleManager({
    audioContextProvider() {
      return {};
    },
    fetchImpl() {
      return Promise.reject(new Error("not used"));
    }
  });

  for (const slotIndex of loadedSlots) {
    const slot = getSampleSlot(manager, slotIndex);

    slot.status = "loaded";
    slot.version = 1;
    slot.sample = {
      sampleRate: 48000,
      channelCount: 1,
      frameCount: 16,
      durationSeconds: 16 / 48000,
      channels: [new Float32Array(16).fill(0.25)]
    };
  }

  return manager;
}

function createManager(loadedSlots) {
  const audioEngine = createReadyAudioEngine();
  const sampleManager = createLoadedSampleManager(loadedSlots);
  const voiceManager = createVoiceManager({ audioEngine, sampleManager });

  return { audioEngine, sampleManager, voiceManager };
}

function descriptor(overrides = {}) {
  const colourIndex = overrides.colourIndex ?? 1;
  const slotIndex = overrides.slotIndex ?? colourIndex - 1;

  return {
    descriptorId: overrides.descriptorId || `d-${colourIndex}-${slotIndex}`,
    analysisId: overrides.analysisId ?? 1,
    colourIndex,
    slotIndex,
    radialCentre: overrides.radialCentre ?? 0.5,
    coverage: overrides.coverage ?? 0.5,
    strength: overrides.strength ?? 0.8,
    cellCount: overrides.cellCount ?? 1,
    componentHint: overrides.componentHint || `colour-${colourIndex}`,
    globalRank: overrides.globalRank ?? 0,
    rankForColour: overrides.rankForColour ?? 0
  };
}

function snapshot(descriptors, analysisId = 1) {
  return {
    type: "playheadDescriptors",
    analysisId,
    descriptors
  };
}

const forwardTransport = {
  actualGlobalSpeed: 1,
  phaseTurns: 0
};

describe("voice manager", () => {
  it("starts a voice for an unmatched descriptor", () => {
    const { audioEngine, voiceManager } = createManager();

    reconcileDescriptors(
      voiceManager,
      snapshot([descriptor({ radialCentre: 0.5 })]),
      forwardTransport
    );

    assert.equal(getVoiceState(voiceManager).activeVoiceCount, 1);
    assert.equal(audioEngine.postedMessages.at(-1).type, "startVoice");
    assert.equal(audioEngine.postedMessages.at(-1).voice.slotIndex, 0);
    assert.equal(audioEngine.postedMessages.at(-1).voice.effectivePlaybackRate, 1);
    assert.equal(audioEngine.postedMessages.at(-1).voice.startPhase, "beginning");
  });

  it("does not start a voice when the mapped sample is missing", () => {
    const { audioEngine, voiceManager } = createManager([1]);

    reconcileDescriptors(
      voiceManager,
      snapshot([descriptor({ colourIndex: 1, slotIndex: 0 })]),
      forwardTransport
    );

    assert.equal(getVoiceState(voiceManager).activeVoiceCount, 0);
    assert.equal(audioEngine.postedMessages.length, 0);
  });

  it("continues a matched descriptor without retriggering and updates rate", () => {
    const { audioEngine, voiceManager } = createManager();

    reconcileDescriptors(
      voiceManager,
      snapshot([descriptor({ descriptorId: "a", radialCentre: 0.5 })], 1),
      forwardTransport
    );
    reconcileDescriptors(
      voiceManager,
      snapshot([descriptor({ descriptorId: "b", radialCentre: 0.6 })], 2),
      forwardTransport
    );

    const messages = audioEngine.postedMessages;

    assert.equal(messages.filter((message) => message.type === "startVoice").length, 1);
    assert.equal(messages.at(-1).type, "updateVoice");
    assert.equal(Number(messages.at(-1).updates.effectivePlaybackRate.toFixed(2)), 1.2);
    assert.equal(getVoiceState(voiceManager).activeVoiceCount, 1);
  });

  it("updates voice rate direction when global speed sign changes without retriggering", () => {
    const { audioEngine, voiceManager } = createManager();

    reconcileDescriptors(
      voiceManager,
      snapshot([descriptor({ descriptorId: "a", radialCentre: 0.5 })], 1),
      forwardTransport
    );
    reconcileDescriptors(
      voiceManager,
      snapshot([descriptor({ descriptorId: "a", radialCentre: 0.5 })], 2),
      { actualGlobalSpeed: -1, phaseTurns: 0 }
    );

    assert.equal(
      audioEngine.postedMessages.filter((message) => message.type === "startVoice").length,
      1
    );
    assert.equal(audioEngine.postedMessages.at(-1).updates.effectivePlaybackRate, -1);
  });

  it("fades matched voices to zero amplitude at near-zero speed", () => {
    const { audioEngine, voiceManager } = createManager();

    reconcileDescriptors(
      voiceManager,
      snapshot([descriptor({ descriptorId: "a", radialCentre: 0.5 })], 1),
      forwardTransport
    );
    reconcileDescriptors(
      voiceManager,
      snapshot([descriptor({ descriptorId: "a", radialCentre: 0.5 })], 2),
      { actualGlobalSpeed: 0.001, phaseTurns: 0 }
    );

    const updates = audioEngine.postedMessages.at(-1).updates;

    assert.equal(updates.amplitude, 0);
    assert.equal(
      audioEngine.postedMessages.filter((message) => message.type === "startVoice").length,
      1
    );
  });

  it("updates matched voices through near-zero and reverse motion without retriggering", () => {
    const { audioEngine, voiceManager } = createManager();

    reconcileDescriptors(
      voiceManager,
      snapshot([descriptor({ descriptorId: "a", radialCentre: 0.5 })], 1),
      { ...forwardTransport, canStartVoices: true }
    );
    reconcileDescriptors(
      voiceManager,
      snapshot([descriptor({ descriptorId: "a", radialCentre: 0.5 })], 2),
      {
        actualGlobalSpeed: 0.001,
        phaseTurns: 0,
        isPaused: true,
        canStartVoices: false
      }
    );
    reconcileDescriptors(
      voiceManager,
      snapshot([descriptor({ descriptorId: "a", radialCentre: 0.5 })], 3),
      { actualGlobalSpeed: -1, phaseTurns: 0, canStartVoices: true }
    );

    const startMessages = audioEngine.postedMessages.filter(
      (message) => message.type === "startVoice"
    );
    const updateMessages = audioEngine.postedMessages.filter(
      (message) => message.type === "updateVoice"
    );

    assert.equal(startMessages.length, 1);
    assert.equal(updateMessages.length, 2);
    assert.equal(updateMessages[0].updates.amplitude, 0);
    assert.equal(updateMessages.at(-1).updates.effectivePlaybackRate, -1);
    assert.equal(getVoiceState(voiceManager).activeVoiceCount, 1);
  });

  it("uses canStartVoices false to block new voices even while moving", () => {
    const { audioEngine, voiceManager } = createManager();

    reconcileDescriptors(
      voiceManager,
      snapshot([descriptor({ descriptorId: "blocked" })], 1),
      {
        actualGlobalSpeed: 1,
        isPaused: false,
        canStartVoices: false,
        phaseTurns: 0
      }
    );

    assert.equal(getVoiceState(voiceManager).activeVoiceCount, 0);
    assert.equal(audioEngine.postedMessages.length, 0);
    assert.equal(getVoiceState(voiceManager).stats.ignoredDescriptors, 1);
  });

  it("uses canStartVoices true to allow new voices from paused snapshots", () => {
    const { audioEngine, voiceManager } = createManager();

    reconcileDescriptors(
      voiceManager,
      snapshot([descriptor({ descriptorId: "manual-drag" })], 1),
      {
        actualGlobalSpeed: 1,
        isPaused: true,
        canStartVoices: true,
        phaseTurns: 0
      }
    );

    assert.equal(getVoiceState(voiceManager).activeVoiceCount, 1);
    assert.equal(audioEngine.postedMessages.at(-1).type, "startVoice");
  });

  it("falls back to isPaused when canStartVoices is omitted", () => {
    const { audioEngine, voiceManager } = createManager();

    reconcileDescriptors(
      voiceManager,
      snapshot([descriptor({ descriptorId: "paused" })], 1),
      { actualGlobalSpeed: 0.5, isPaused: true, phaseTurns: 0 }
    );

    assert.equal(getVoiceState(voiceManager).activeVoiceCount, 0);
    assert.equal(audioEngine.postedMessages.length, 0);
  });

  it("stops a voice when its descriptor disappears", () => {
    const { audioEngine, voiceManager } = createManager();

    reconcileDescriptors(
      voiceManager,
      snapshot([descriptor()], 1),
      forwardTransport
    );
    reconcileDescriptors(voiceManager, snapshot([], 2), forwardTransport);

    assert.equal(getVoiceState(voiceManager).activeVoiceCount, 0);
    assert.equal(audioEngine.postedMessages.at(-1).type, "stopVoice");
  });

  it("creates separate voices for separated same-colour descriptors", () => {
    const { audioEngine, voiceManager } = createManager();

    reconcileDescriptors(
      voiceManager,
      snapshot(
        [
          descriptor({ descriptorId: "low", radialCentre: 0.2, globalRank: 0 }),
          descriptor({ descriptorId: "high", radialCentre: 0.8, globalRank: 1 })
        ],
        1
      ),
      forwardTransport
    );

    assert.equal(getVoiceState(voiceManager).activeVoiceCount, 2);
    assert.equal(
      audioEngine.postedMessages.filter((message) => message.type === "startVoice").length,
      2
    );
  });

  it("treats a broad component descriptor as one voice", () => {
    const { audioEngine, voiceManager } = createManager();

    reconcileDescriptors(
      voiceManager,
      snapshot([
        descriptor({
          descriptorId: "broad",
          radialCentre: 0.45,
          coverage: 0.9,
          cellCount: 20
        })
      ]),
      forwardTransport
    );

    assert.equal(getVoiceState(voiceManager).activeVoiceCount, 1);
    assert.equal(
      audioEngine.postedMessages.filter((message) => message.type === "startVoice").length,
      1
    );
  });

  it("audio recovery stops stale voices and rebuilds from current descriptors", () => {
    const { audioEngine, voiceManager } = createManager();

    reconcileDescriptors(
      voiceManager,
      snapshot([descriptor({ descriptorId: "old" })], 1),
      forwardTransport
    );
    recoverVoicesFromCurrentDescriptors(
      voiceManager,
      snapshot([descriptor({ descriptorId: "current" })], 2),
      forwardTransport
    );

    const messages = audioEngine.postedMessages;

    assert.equal(messages.filter((message) => message.type === "stopVoice").length, 1);
    assert.equal(messages.filter((message) => message.type === "startVoice").length, 2);
    assert.equal(getVoiceState(voiceManager).activeVoiceCount, 1);
    assert.equal(voiceManager.commandLog.at(-2).reason, "audio-recovery");
  });
});
