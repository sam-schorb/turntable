import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AUDIO_CONFIG } from "../src/config.js";
import { createDirtyRegion } from "../src/dirty-regions.js";
import { angleColumnToTurns, createDiscGeometry } from "../src/geometry.js";
import {
  analyzePlayhead,
  createPlayheadAnalyzer
} from "../src/playhead-analyzer.js";
import {
  createReaderEngine,
  getReaderState,
  runReaderEngine
} from "../src/reader-engine.js";
import { createSampleManager, getSampleSlot } from "../src/sample-manager.js";
import { createScore, setCell } from "../src/score.js";
import { createScoreSync } from "../src/score-sync.js";
import { createVoiceManager } from "../src/voice-manager.js";

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

function createLockedAudioEngine() {
  return {
    status: "locked",
    config: AUDIO_CONFIG,
    postedMessages: []
  };
}

function createLoadedSampleManager() {
  const manager = createSampleManager({
    audioContextProvider() {
      return {};
    },
    fetchImpl() {
      return Promise.reject(new Error("not used"));
    }
  });

  for (let slotIndex = 0; slotIndex < 6; slotIndex += 1) {
    const slot = getSampleSlot(manager, slotIndex);

    slot.status = "loaded";
    slot.version = 1;
    slot.sample = {
      sampleRate: 48000,
      channelCount: 1,
      frameCount: 32,
      durationSeconds: 32 / 48000,
      channels: [new Float32Array(32).fill(0.25)]
    };
  }

  return manager;
}

function setup({ audioEngine = createReadyAudioEngine() } = {}) {
  const score = createScore({ angleColumns: 512, radialRows: 128 });
  const geometry = createDiscGeometry({ width: 400, height: 400 });
  const analyzer = createPlayheadAnalyzer({ score, geometry });
  const scoreSync = createScoreSync({ score, analyzer, audioEngine });
  const sampleManager = createLoadedSampleManager();
  const voiceManager = createVoiceManager({ audioEngine, sampleManager });
  const reader = createReaderEngine({
    analyzer,
    scoreSync,
    audioEngine,
    voiceManager,
    getGeometry: () => geometry
  });

  return {
    score,
    analyzer,
    scoreSync,
    audioEngine,
    reader,
    snapshot: {
      phaseTurns: angleColumnToTurns(score, 0),
      actualGlobalSpeed: 1,
      isPlaying: true,
      isRamping: false,
      isPaused: false
    }
  };
}

function createManualDragSnapshot(score, angleColumn, overrides = {}) {
  return {
    phaseTurns: angleColumnToTurns(score, angleColumn),
    actualGlobalSpeed: overrides.actualGlobalSpeed ?? 1,
    isPlaying: false,
    isRamping: false,
    isPaused: true,
    handGrabActive: true,
    canStartVoices: true,
    motionSource: "hand",
    timeSeconds: overrides.timeSeconds ?? 1,
    ...overrides
  };
}

function voiceMessages(audioEngine, type) {
  return audioEngine.postedMessages.filter((message) => message.type === type);
}

class FakeReaderWorker {
  constructor() {
    this.messages = [];
    this.onmessage = null;
    this.onerror = null;
    this.terminated = false;
  }

  postMessage(message) {
    this.messages.push(message);

    if (message.type === "init") {
      this.onmessage?.({
        data: {
          type: "initialized",
          scoreVersion: message.scoreUpdate.scoreVersion
        }
      });
    }
  }

  terminate() {
    this.terminated = true;
  }
}

describe("reader engine", () => {
  it("publishes dirty invalidation even when audio is not ready", () => {
    const { score, analyzer, scoreSync, reader, snapshot } = setup({
      audioEngine: createLockedAudioEngine()
    });

    setCell(score, 0, 64, 1, 255);
    const dirtyRegion = createDirtyRegion(
      score,
      [{ angleColumn: 0, radialRow: 64 }],
      "paint"
    );
    const result = runReaderEngine(reader, {
      snapshot,
      dirtyRegions: [dirtyRegion],
      audioState: { status: "locked" },
      nowSeconds: 1
    });

    assert.equal(result.ran, false);
    assert.equal(result.reason, "audio_not_ready");
    assert.equal(analyzer.dirty, true);
    assert.equal(scoreSync.stats.dirtyPayloads, 1);
    assert.equal(getReaderState(reader).stats.invalidations, 1);
  });

  it("analyzes and reconciles voices without a visual render call", () => {
    const { score, audioEngine, reader, snapshot } = setup();

    setCell(score, 0, 64, 1, 255);
    const result = runReaderEngine(reader, {
      snapshot,
      nowSeconds: 2,
      audioState: { status: "ready" },
      force: true
    });
    const startMessages = audioEngine.postedMessages.filter(
      (message) => message.type === "startVoice"
    );

    assert.equal(result.ran, true);
    assert.equal(result.descriptorPayload.descriptors.length, 1);
    assert.equal(result.voiceState.activeVoiceCount, 1);
    assert.equal(startMessages.length, 1);
    assert.equal(startMessages[0].voice.slotIndex, 0);
  });

  it("reconciles paused snapshots when canStartVoices allows starts", () => {
    const { score, audioEngine, reader, snapshot } = setup();

    setCell(score, 0, 64, 1, 255);
    const result = runReaderEngine(reader, {
      snapshot: {
        ...snapshot,
        actualGlobalSpeed: 1,
        isPlaying: false,
        isPaused: true,
        canStartVoices: true
      },
      nowSeconds: 2.5,
      audioState: { status: "ready" }
    });
    const startMessages = audioEngine.postedMessages.filter(
      (message) => message.type === "startVoice"
    );

    assert.equal(result.ran, true);
    assert.equal(result.descriptorPayload.descriptors.length, 1);
    assert.equal(result.voiceState.activeVoiceCount, 1);
    assert.equal(startMessages.length, 1);
  });

  it("runs from signed motion snapshots even without dirty regions", () => {
    const { score, reader, snapshot } = setup();

    setCell(score, 0, 64, 1, 255);
    const result = runReaderEngine(reader, {
      snapshot: {
        ...snapshot,
        phaseTurns: snapshot.phaseTurns,
        actualGlobalSpeed: -1,
        isPlaying: false
      },
      nowSeconds: 3,
      audioState: { status: "ready" }
    });

    assert.equal(result.ran, true);
    assert.equal(result.descriptorPayload.descriptors.length, 1);
    assert.equal(getReaderState(reader).lastRunReason, "scheduled");
  });

  it("starts a voice from positive manual-drag motion while the motor is paused", () => {
    const { score, audioEngine, reader } = setup();

    setCell(score, 0, 64, 1, 255);
    const result = runReaderEngine(reader, {
      snapshot: createManualDragSnapshot(score, 0, {
        actualGlobalSpeed: 1.25
      }),
      nowSeconds: 3.1,
      audioState: { status: "ready" }
    });
    const starts = voiceMessages(audioEngine, "startVoice");

    assert.equal(result.ran, true);
    assert.equal(result.voiceState.activeVoiceCount, 1);
    assert.equal(starts.length, 1);
    assert.ok(starts[0].voice.effectivePlaybackRate > 1.24);
    assert.equal(starts[0].voice.startPhase, "beginning");
  });

  it("starts reverse manual-drag voices with negative effective playback rate", () => {
    const { score, audioEngine, reader } = setup();

    setCell(score, 0, 64, 1, 255);
    runReaderEngine(reader, {
      snapshot: createManualDragSnapshot(score, 0, {
        actualGlobalSpeed: -1.5
      }),
      nowSeconds: 3.2,
      audioState: { status: "ready" }
    });

    const start = voiceMessages(audioEngine, "startVoice")[0];

    assert.ok(start.voice.effectivePlaybackRate < -1.49);
    assert.equal(start.voice.startPhase, "end");
  });

  it("updates manual-drag pitch as hand speed increases", () => {
    const { score, audioEngine, reader } = setup();

    setCell(score, 0, 64, 1, 255);
    runReaderEngine(reader, {
      snapshot: createManualDragSnapshot(score, 0, {
        actualGlobalSpeed: 0.5,
        timeSeconds: 4
      }),
      nowSeconds: 4,
      audioState: { status: "ready" }
    });
    runReaderEngine(reader, {
      snapshot: createManualDragSnapshot(score, 0, {
        actualGlobalSpeed: 2,
        timeSeconds: 4.01
      }),
      nowSeconds: 4.01,
      audioState: { status: "ready" }
    });

    const starts = voiceMessages(audioEngine, "startVoice");
    const updates = voiceMessages(audioEngine, "updateVoice");

    assert.equal(starts.length, 1);
    assert.ok(
      updates.at(-1).updates.effectivePlaybackRate >
        starts[0].voice.effectivePlaybackRate
    );
  });

  it("does not start a fresh manual-drag voice below the trigger threshold", () => {
    const { score, audioEngine, reader } = setup();

    setCell(score, 0, 64, 1, 255);
    const result = runReaderEngine(reader, {
      snapshot: createManualDragSnapshot(score, 0, {
        actualGlobalSpeed: 0.00001
      }),
      nowSeconds: 4.2,
      audioState: { status: "ready" }
    });

    assert.equal(result.descriptorPayload.descriptors.length, 1);
    assert.equal(result.voiceState.activeVoiceCount, 0);
    assert.equal(voiceMessages(audioEngine, "startVoice").length, 0);
  });

  it("updates an existing manual-drag voice on direction reversal instead of retriggering", () => {
    const { score, audioEngine, reader } = setup();

    setCell(score, 0, 64, 1, 255);
    runReaderEngine(reader, {
      snapshot: createManualDragSnapshot(score, 0, {
        actualGlobalSpeed: 1,
        timeSeconds: 5
      }),
      nowSeconds: 5,
      audioState: { status: "ready" }
    });
    runReaderEngine(reader, {
      snapshot: createManualDragSnapshot(score, 0, {
        actualGlobalSpeed: -1,
        timeSeconds: 5.01
      }),
      nowSeconds: 5.01,
      audioState: { status: "ready" }
    });

    assert.equal(voiceMessages(audioEngine, "startVoice").length, 1);
    assert.ok(
      voiceMessages(audioEngine, "updateVoice").at(-1).updates
        .effectivePlaybackRate < 0
    );
  });

  it("allows a new manual-drag crossing after descriptor disappearance and re-entry", () => {
    const { score, audioEngine, reader } = setup();

    setCell(score, 0, 64, 1, 255);
    runReaderEngine(reader, {
      snapshot: createManualDragSnapshot(score, 0, {
        actualGlobalSpeed: 1,
        timeSeconds: 6
      }),
      nowSeconds: 6,
      audioState: { status: "ready" }
    });
    runReaderEngine(reader, {
      snapshot: createManualDragSnapshot(score, 96, {
        actualGlobalSpeed: 1,
        timeSeconds: 6.01
      }),
      nowSeconds: 6.01,
      audioState: { status: "ready" }
    });
    runReaderEngine(reader, {
      snapshot: createManualDragSnapshot(score, 96, {
        actualGlobalSpeed: 1,
        timeSeconds: 6.02
      }),
      nowSeconds: 6.02,
      audioState: { status: "ready" }
    });
    runReaderEngine(reader, {
      snapshot: createManualDragSnapshot(score, 0, {
        actualGlobalSpeed: 1,
        timeSeconds: 6.03
      }),
      nowSeconds: 6.03,
      audioState: { status: "ready" }
    });

    assert.equal(voiceMessages(audioEngine, "startVoice").length, 2);
    assert.equal(voiceMessages(audioEngine, "stopVoice").length, 1);
  });

  it("keeps broad continuous manual-drag material as one voice", () => {
    const { score, audioEngine, reader } = setup();

    for (const angleColumn of [0, 1, 2]) {
      for (const radialRow of [63, 64, 65]) {
        setCell(score, angleColumn, radialRow, 1, 255);
      }
    }

    const result = runReaderEngine(reader, {
      snapshot: createManualDragSnapshot(score, 0),
      nowSeconds: 7,
      audioState: { status: "ready" }
    });

    assert.equal(result.descriptorPayload.descriptors.length, 1);
    assert.equal(result.voiceState.activeVoiceCount, 1);
    assert.equal(voiceMessages(audioEngine, "startVoice").length, 1);
  });

  it("keeps separated same-colour manual-drag material as separate voices", () => {
    const { score, audioEngine, reader } = setup();

    setCell(score, 0, 40, 1, 255);
    setCell(score, 0, 90, 1, 255);
    const result = runReaderEngine(reader, {
      snapshot: createManualDragSnapshot(score, 0),
      nowSeconds: 7.1,
      audioState: { status: "ready" }
    });

    assert.equal(result.descriptorPayload.descriptors.length, 2);
    assert.equal(result.voiceState.activeVoiceCount, 2);
    assert.equal(voiceMessages(audioEngine, "startVoice").length, 2);
  });

  it("keeps different colours under manual drag as separate voices", () => {
    const { score, audioEngine, reader } = setup();

    setCell(score, 0, 64, 1, 255);
    setCell(score, 0, 70, 4, 255);
    const result = runReaderEngine(reader, {
      snapshot: createManualDragSnapshot(score, 0),
      nowSeconds: 7.2,
      audioState: { status: "ready" }
    });

    assert.equal(result.descriptorPayload.descriptors.length, 2);
    assert.equal(result.voiceState.activeVoiceCount, 2);
    assert.equal(voiceMessages(audioEngine, "startVoice").length, 2);
  });

  it("detects a narrow mark swept between reader ticks at the real reader cadence", () => {
    const { score, audioEngine, reader } = setup();
    const markColumn = 96;

    setCell(score, markColumn, 64, 1, 255);
    runReaderEngine(reader, {
      snapshot: createManualDragSnapshot(score, 0, {
        actualGlobalSpeed: 4,
        timeSeconds: 8
      }),
      nowSeconds: 8,
      audioState: { status: "ready" }
    });

    const swept = runReaderEngine(reader, {
      snapshot: createManualDragSnapshot(score, 192, {
        actualGlobalSpeed: 4,
        timeSeconds: 8.008
      }),
      nowSeconds: 8.008,
      audioState: { status: "ready" }
    });

    assert.equal(swept.descriptorPayload.descriptors.length, 1);
    assert.equal(voiceMessages(audioEngine, "startVoice").length, 1);
  });

  it("uses signed motion samples to detect a between-tick direction reversal", () => {
    const { score, audioEngine, reader } = setup();
    const markColumn = 80;
    const startPhase = angleColumnToTurns(score, 0);
    const markPhase = angleColumnToTurns(score, markColumn);

    setCell(score, markColumn, 64, 1, 255);
    runReaderEngine(reader, {
      snapshot: createManualDragSnapshot(score, 0, {
        actualGlobalSpeed: 1,
        timeSeconds: 9,
        unwrappedPhaseTurns: startPhase
      }),
      nowSeconds: 9,
      audioState: { status: "ready" }
    });

    const reversed = runReaderEngine(reader, {
      snapshot: createManualDragSnapshot(score, 0, {
        actualGlobalSpeed: -1,
        timeSeconds: 9.016,
        unwrappedPhaseTurns: startPhase,
        motionSamples: [
          {
            seconds: 9,
            phaseTurns: startPhase,
            unwrappedPhaseTurns: startPhase
          },
          {
            seconds: 9.008,
            phaseTurns: markPhase,
            unwrappedPhaseTurns: markPhase
          },
          {
            seconds: 9.016,
            phaseTurns: startPhase,
            unwrappedPhaseTurns: startPhase
          }
        ]
      }),
      nowSeconds: 9.016,
      audioState: { status: "ready" }
    });

    assert.equal(reversed.descriptorPayload.descriptors.length, 1);
    assert.equal(voiceMessages(audioEngine, "startVoice").length, 1);
    assert.ok(
      voiceMessages(audioEngine, "startVoice")[0].voice
        .effectivePlaybackRate < 0
    );
  });

  it("schedules normal analysis on a worker and applies async descriptor results", () => {
    const worker = new FakeReaderWorker();
    const { score, analyzer, audioEngine, snapshot } = setup();
    const scoreSync = createScoreSync({ score, analyzer, audioEngine });
    const sampleManager = createLoadedSampleManager();
    const voiceManager = createVoiceManager({ audioEngine, sampleManager });
    const reader = createReaderEngine({
      analyzer,
      scoreSync,
      audioEngine,
      voiceManager,
      getGeometry: () => createDiscGeometry({ width: 400, height: 400 }),
      workerFactory: () => worker
    });

    setCell(score, 0, 64, 1, 255);
    const result = runReaderEngine(reader, {
      snapshot,
      nowSeconds: 4,
      audioState: { status: "ready" }
    });
    const analyzeMessage = worker.messages.find(
      (message) => message.type === "analyze"
    );

    assert.equal(result.pending, true);
    assert.equal(result.reason, "worker_scheduled");
    assert.equal(audioEngine.postedMessages.some((message) => message.type === "startVoice"), false);
    assert.ok(analyzeMessage);

    worker.onmessage({
      data: {
        type: "analysisResult",
        requestId: analyzeMessage.requestId,
        payload: analyzePlayhead(analyzer, snapshot),
        scoreVersion: score.version
      }
    });

    assert.equal(
      audioEngine.postedMessages.filter((message) => message.type === "startVoice")
        .length,
      1
    );
    assert.equal(getReaderState(reader).backend.mode, "worker");
    assert.equal(getReaderState(reader).stats.workerRequests, 1);
  });

  it("sends dirty score patches to the worker after initialization", () => {
    const worker = new FakeReaderWorker();
    const { score, analyzer, audioEngine, snapshot } = setup();
    const scoreSync = createScoreSync({ score, analyzer, audioEngine });
    const sampleManager = createLoadedSampleManager();
    const voiceManager = createVoiceManager({ audioEngine, sampleManager });
    const reader = createReaderEngine({
      analyzer,
      scoreSync,
      audioEngine,
      voiceManager,
      getGeometry: () => createDiscGeometry({ width: 400, height: 400 }),
      workerFactory: () => worker
    });

    setCell(score, 0, 64, 1, 255);
    const dirtyRegion = createDirtyRegion(
      score,
      [{ angleColumn: 0, radialRow: 64 }],
      "paint"
    );

    runReaderEngine(reader, {
      snapshot,
      dirtyRegions: [dirtyRegion],
      nowSeconds: 5,
      audioState: { status: "ready" }
    });

    const analyzeMessage = worker.messages.find(
      (message) => message.type === "analyze"
    );

    assert.equal(analyzeMessage.scoreUpdate.type, "patch");
    assert.equal(analyzeMessage.scoreUpdate.scoreVersion, score.version);
    assert.ok(analyzeMessage.scoreUpdate.indices.length > 0);
  });

  it("falls back to the main reader if worker analysis reports an error", () => {
    const worker = new FakeReaderWorker();
    const { score, analyzer, audioEngine, snapshot } = setup();
    const scoreSync = createScoreSync({ score, analyzer, audioEngine });
    const sampleManager = createLoadedSampleManager();
    const voiceManager = createVoiceManager({ audioEngine, sampleManager });
    const reader = createReaderEngine({
      analyzer,
      scoreSync,
      audioEngine,
      voiceManager,
      getGeometry: () => createDiscGeometry({ width: 400, height: 400 }),
      workerFactory: () => worker
    });

    setCell(score, 0, 64, 1, 255);
    const scheduled = runReaderEngine(reader, {
      snapshot,
      nowSeconds: 6,
      audioState: { status: "ready" }
    });
    const analyzeMessage = worker.messages.find(
      (message) => message.type === "analyze"
    );

    assert.equal(scheduled.reason, "worker_scheduled");
    worker.onmessage({
      data: {
        type: "error",
        requestId: analyzeMessage.requestId,
        message: "worker exploded"
      }
    });

    const failedState = getReaderState(reader);

    assert.equal(worker.terminated, true);
    assert.equal(failedState.backend.mode, "main");
    assert.equal(failedState.backend.workerPending, false);
    assert.equal(failedState.backend.lastWorkerError, "worker exploded");
    assert.equal(failedState.stats.workerFallbacks, 1);
    assert.equal(failedState.stats.workerErrors, 1);

    const recovered = runReaderEngine(reader, {
      snapshot,
      nowSeconds: 7,
      audioState: { status: "ready" }
    });

    assert.equal(recovered.ran, true);
    assert.equal(recovered.descriptorPayload.descriptors.length, 1);
    assert.equal(getReaderState(reader).lastRunReason, "scheduled");
  });
});
