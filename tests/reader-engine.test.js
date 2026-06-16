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
