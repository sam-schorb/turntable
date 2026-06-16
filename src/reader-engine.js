import {
  getAudioEngineState,
  sendPlayheadDescriptors,
  sendTransportSnapshot
} from "./audio-engine.js";
import {
  analyzePlayhead,
  invalidateDescriptors
} from "./playhead-analyzer.js";
import {
  syncDescriptorSnapshot,
  syncDirtyRegions
} from "./score-sync.js";
import {
  getVoiceState,
  reconcileDescriptors,
  recoverVoicesFromCurrentDescriptors
} from "./voice-manager.js";

const PHASE_EPSILON = 0.000001;
const SPEED_EPSILON = 0.000001;
const WORKER_PATCH_CELL_LIMIT = 180000;

function normalizeDirtyRegions(dirtyRegions) {
  return (Array.isArray(dirtyRegions) ? dirtyRegions : [dirtyRegions]).filter(
    Boolean
  );
}

function cloneGeometry(geometry) {
  return geometry
    ? {
        ...geometry,
        center: geometry.center ? { ...geometry.center } : null,
        guideRadii: Array.isArray(geometry.guideRadii)
          ? geometry.guideRadii.slice()
          : geometry.guideRadii
      }
    : null;
}

function hasReadableGeometry(reader) {
  return typeof reader.getGeometry !== "function" || Boolean(reader.getGeometry());
}

function phaseChanged(previousSnapshot, nextSnapshot) {
  if (!previousSnapshot || !nextSnapshot) {
    return false;
  }

  if (
    !Number.isFinite(previousSnapshot.phaseTurns) ||
    !Number.isFinite(nextSnapshot.phaseTurns)
  ) {
    return false;
  }

  return (
    Math.abs(previousSnapshot.phaseTurns - nextSnapshot.phaseTurns) >
    PHASE_EPSILON
  );
}

function snapshotHasMotion(snapshot) {
  if (!snapshot) {
    return false;
  }

  return (
    snapshot.isPlaying ||
    snapshot.isRamping ||
    (Number.isFinite(snapshot.actualGlobalSpeed) &&
      Math.abs(snapshot.actualGlobalSpeed) > SPEED_EPSILON)
  );
}

function shouldRunReader(reader, snapshot, dirtyRegions, audioState, options) {
  if (options.force || options.recover) {
    return true;
  }

  if (!audioState || audioState.status !== "ready") {
    return false;
  }

  if (dirtyRegions.length > 0 || reader.analyzer.dirty) {
    return true;
  }

  if (snapshotHasMotion(snapshot)) {
    return true;
  }

  if (phaseChanged(reader.latestMotionSnapshot, snapshot)) {
    return true;
  }

  return reader.latestVoiceState && reader.latestVoiceState.activeVoiceCount > 0;
}

function createSkippedResult(reader, snapshot, reason) {
  reader.latestMotionSnapshot = snapshot || reader.latestMotionSnapshot;
  reader.stats.skipped += 1;
  reader.lastRunReason = reason;

  return Object.freeze({
    ran: false,
    reason,
    snapshot,
    descriptorPayload: reader.latestDescriptorPayload,
    voiceState: reader.latestVoiceState,
    readerState: getReaderState(reader)
  });
}

function analyzeReaderSnapshot(reader, snapshot) {
  if (!hasReadableGeometry(reader)) {
    return reader.analyzer.lastPayload;
  }

  return analyzePlayhead(reader.analyzer, snapshot);
}

function getRegionColumnCount(score, region) {
  if (region.fullScore) {
    return score.angleColumns;
  }

  if (region.wraps) {
    return score.angleColumns - region.minAngleColumn + region.maxAngleColumn + 1;
  }

  return region.maxAngleColumn - region.minAngleColumn + 1;
}

function estimateRegionCellCount(score, regions) {
  return regions.reduce((total, region) => {
    const rowCount = region.fullScore
      ? score.radialRows
      : region.maxRadialRow - region.minRadialRow + 1;

    return total + getRegionColumnCount(score, region) * rowCount;
  }, 0);
}

function forEachRegionCell(score, region, visit) {
  const minRow = region.fullScore ? 0 : region.minRadialRow;
  const maxRow = region.fullScore ? score.radialRows - 1 : region.maxRadialRow;
  const visitColumnRange = (start, end) => {
    for (let angleColumn = start; angleColumn <= end; angleColumn += 1) {
      for (let radialRow = minRow; radialRow <= maxRow; radialRow += 1) {
        visit(angleColumn, radialRow);
      }
    }
  };

  if (region.fullScore) {
    visitColumnRange(0, score.angleColumns - 1);
    return;
  }

  if (region.wraps) {
    visitColumnRange(region.minAngleColumn, score.angleColumns - 1);
    visitColumnRange(0, region.maxAngleColumn);
    return;
  }

  visitColumnRange(region.minAngleColumn, region.maxAngleColumn);
}

function createFullScoreUpdate(score) {
  const colours = new Uint8Array(score.colours);
  const strengths = new Uint8Array(score.strengths);

  return {
    update: {
      type: "full",
      scoreVersion: score.version,
      angleColumns: score.angleColumns,
      radialRows: score.radialRows,
      colourCount: score.colourCount,
      colours,
      strengths
    },
    transferList: [colours.buffer, strengths.buffer]
  };
}

function createPatchScoreUpdate(score, regions) {
  const estimatedCellCount = estimateRegionCellCount(score, regions);

  if (estimatedCellCount <= 0 || estimatedCellCount > WORKER_PATCH_CELL_LIMIT) {
    return createFullScoreUpdate(score);
  }

  const seen = new Set();
  const indices = [];

  for (const region of regions) {
    if (region.fullScore) {
      return createFullScoreUpdate(score);
    }

    forEachRegionCell(score, region, (angleColumn, radialRow) => {
      const index = radialRow * score.angleColumns + angleColumn;

      if (!seen.has(index)) {
        seen.add(index);
        indices.push(index);
      }
    });
  }

  const indexArray = new Uint32Array(indices.length);
  const colourArray = new Uint8Array(indices.length);
  const strengthArray = new Uint8Array(indices.length);

  for (let offset = 0; offset < indices.length; offset += 1) {
    const index = indices[offset];

    indexArray[offset] = index;
    colourArray[offset] = score.colours[index];
    strengthArray[offset] = score.strengths[index];
  }

  return {
    update: {
      type: "patch",
      scoreVersion: score.version,
      indices: indexArray,
      colours: colourArray,
      strengths: strengthArray
    },
    transferList: [indexArray.buffer, colourArray.buffer, strengthArray.buffer]
  };
}

function createWorkerScoreUpdate(reader) {
  const score = reader.analyzer.score;

  if (
    !reader.workerReady ||
    reader.workerScoreVersion === null ||
    reader.workerScoreVersion === undefined
  ) {
    return createFullScoreUpdate(score);
  }

  if (reader.workerScoreVersion === score.version) {
    return {
      update: null,
      transferList: []
    };
  }

  if (reader.workerDirtyRegions.length === 0) {
    return createFullScoreUpdate(score);
  }

  return createPatchScoreUpdate(score, reader.workerDirtyRegions);
}

function appendWorkerDirtyRegions(reader, regions) {
  if (!reader.worker) {
    return;
  }

  if (regions.some((region) => region.fullScore)) {
    reader.workerDirtyRegions = regions.filter((region) => region.fullScore);
    return;
  }

  reader.workerDirtyRegions.push(...regions);
}

function markWorkerUnavailable(reader, reason) {
  if (reader.worker) {
    try {
      reader.worker.terminate();
    } catch {
      // The worker may already be gone.
    }
  }

  reader.worker = null;
  reader.workerReady = false;
  reader.workerPendingRequest = null;
  reader.workerQueuedRequest = null;
  reader.workerScoreVersion = null;
  reader.status = "main_thread_reader_engine";
  reader.lastWorkerError = reason || null;
  reader.stats.workerFallbacks += 1;
}

function postWorkerMessage(reader, message, transferList = []) {
  if (!reader.worker) {
    return false;
  }

  try {
    reader.worker.postMessage(message, transferList);
    return true;
  } catch (error) {
    markWorkerUnavailable(
      reader,
      error && error.message ? error.message : String(error)
    );
    return false;
  }
}

function applyDescriptorPayload(
  reader,
  descriptorPayload,
  snapshot,
  { nowSeconds = null, recover = false, reason = "scheduled" } = {}
) {
  reader.latestDescriptorSyncPayload = syncDescriptorSnapshot(
    reader.scoreSync,
    descriptorPayload
  );
  sendTransportSnapshot(reader.audioEngine, snapshot);
  sendPlayheadDescriptors(reader.audioEngine, descriptorPayload);
  reader.latestVoiceState = recover
    ? recoverVoicesFromCurrentDescriptors(
        reader.voiceManager,
        descriptorPayload,
        snapshot
      )
    : reconcileDescriptors(reader.voiceManager, descriptorPayload, snapshot);
  reader.latestMotionSnapshot = snapshot;
  reader.latestDescriptorPayload = descriptorPayload;
  reader.latestScoreVersionSeen = reader.analyzer.score.version;
  reader.analyzer.lastPayload = descriptorPayload;
  reader.analyzer.lastScoreVersion = reader.analyzer.score.version;
  reader.analyzer.analysisId = Math.max(
    reader.analyzer.analysisId,
    descriptorPayload.analysisId || 0
  );
  reader.analyzer.dirty = false;
  reader.lastReconciliationTimeSeconds = Number.isFinite(nowSeconds)
    ? nowSeconds
    : null;
  reader.lastRunReason = reason;
  reader.stats.runs += 1;
  reader.stats.descriptorPayloads += 1;

  if (recover) {
    reader.stats.recoveries += 1;
  }

  if (typeof reader.onVoiceStateChange === "function") {
    reader.onVoiceStateChange(reader.latestVoiceState);
  }

  return Object.freeze({
    ran: true,
    reason: reader.lastRunReason,
    snapshot,
    descriptorPayload,
    voiceState: reader.latestVoiceState,
    readerState: getReaderState(reader)
  });
}

function syncAnalyzeReader(reader, snapshot, options = {}) {
  const descriptorPayload = analyzeReaderSnapshot(reader, snapshot);

  if (!descriptorPayload) {
    return createSkippedResult(reader, snapshot, "descriptor_unavailable");
  }

  return applyDescriptorPayload(reader, descriptorPayload, snapshot, options);
}

function createWorkerRequest(reader, { snapshot, nowSeconds, force, recover }) {
  const scoreUpdate = createWorkerScoreUpdate(reader);
  const geometry = cloneGeometry(
    typeof reader.getGeometry === "function" ? reader.getGeometry() : null
  );
  const requestId = reader.nextWorkerRequestId + 1;

  reader.nextWorkerRequestId = requestId;

  return {
    request: {
      type: "analyze",
      requestId,
      scoreUpdate: scoreUpdate.update,
      geometry,
      transportSnapshot: snapshot
    },
    transferList: scoreUpdate.transferList,
    context: {
      requestId,
      snapshot,
      nowSeconds,
      force: Boolean(force),
      recover: Boolean(recover)
    }
  };
}

function scheduleWorkerAnalysis(reader, options) {
  if (!reader.worker || !reader.workerReady) {
    return false;
  }

  if (reader.workerPendingRequest) {
    reader.workerQueuedRequest = {
      ...options,
      force: Boolean(options.force),
      recover: Boolean(options.recover)
    };
    reader.stats.workerCoalesced += 1;
    return "worker_coalesced";
  }

  const workerRequest = createWorkerRequest(reader, options);
  const posted = postWorkerMessage(
    reader,
    workerRequest.request,
    workerRequest.transferList
  );

  if (!posted) {
    return false;
  }

  reader.workerPendingRequest = workerRequest.context;
  reader.workerDirtyRegions = [];
  reader.lastRunReason = "worker_scheduled";
  reader.stats.workerRequests += 1;
  return "worker_scheduled";
}

function flushQueuedWorkerAnalysis(reader) {
  if (!reader.workerQueuedRequest || reader.workerPendingRequest) {
    return;
  }

  const queuedRequest = reader.workerQueuedRequest;

  reader.workerQueuedRequest = null;
  scheduleWorkerAnalysis(reader, queuedRequest);
}

function handleWorkerAnalysisResult(reader, message) {
  const pending = reader.workerPendingRequest;

  if (!pending || pending.requestId !== message.requestId) {
    reader.stats.workerStaleResults += 1;
    return;
  }

  reader.workerPendingRequest = null;
  reader.workerScoreVersion = Number.isInteger(message.scoreVersion)
    ? message.scoreVersion
    : reader.workerScoreVersion;

  if (message.payload) {
    applyDescriptorPayload(reader, message.payload, pending.snapshot, {
      nowSeconds: pending.nowSeconds,
      recover: pending.recover,
      reason: pending.recover
        ? "worker_recover"
        : pending.force
          ? "worker_force"
          : "worker"
    });
  } else {
    reader.stats.workerErrors += 1;
    reader.lastWorkerError = message.reason || "worker returned no payload";
  }

  flushQueuedWorkerAnalysis(reader);
}

function handleWorkerMessage(reader, event) {
  const message = event && event.data ? event.data : event;

  if (!message || typeof message.type !== "string") {
    return;
  }

  if (message.type === "initialized") {
    reader.workerReady = true;
    reader.workerScoreVersion = Number.isInteger(message.scoreVersion)
      ? message.scoreVersion
      : reader.workerScoreVersion;
    reader.status = "worker_backed_reader_engine";
    return;
  }

  if (message.type === "analysisResult") {
    handleWorkerAnalysisResult(reader, message);
    return;
  }

  if (message.type === "error") {
    reader.stats.workerErrors += 1;
    markWorkerUnavailable(reader, message.message || "reader worker error");
  }
}

function initializeWorker(reader) {
  if (!reader.worker) {
    return;
  }

  const scoreUpdate = createFullScoreUpdate(reader.analyzer.score);
  const geometry = cloneGeometry(
    typeof reader.getGeometry === "function" ? reader.getGeometry() : null
  );

  postWorkerMessage(
    reader,
    {
      type: "init",
      scoreUpdate: scoreUpdate.update,
      geometry
    },
    scoreUpdate.transferList
  );
}

function createReaderWorker(reader, scope, workerFactory) {
  if (typeof workerFactory === "function") {
    return workerFactory();
  }

  const WorkerConstructor = scope && scope.Worker;

  if (typeof WorkerConstructor !== "function") {
    return null;
  }

  return new WorkerConstructor(new URL("./reader-worker.js", import.meta.url), {
    type: "module"
  });
}

export function createReaderEngine({
  analyzer,
  scoreSync,
  audioEngine,
  voiceManager,
  getGeometry = null,
  scope = globalThis,
  preferWorker = true,
  workerFactory = null,
  onVoiceStateChange = null
} = {}) {
  if (!analyzer || !scoreSync || !audioEngine || !voiceManager) {
    throw new TypeError(
      "analyzer, scoreSync, audioEngine, and voiceManager are required."
    );
  }

  const reader = {
    status: "main_thread_reader_engine",
    analyzer,
    scoreSync,
    audioEngine,
    voiceManager,
    getGeometry,
    onVoiceStateChange,
    latestScoreVersionSeen: analyzer.score ? analyzer.score.version : 0,
    latestMotionSnapshot: null,
    latestDescriptorPayload: analyzer.lastPayload || null,
    latestDirtyRegions: [],
    latestDirtyPayload: null,
    latestDescriptorSyncPayload: null,
    latestVoiceState: getVoiceState(voiceManager),
    lastReconciliationTimeSeconds: null,
    lastRunReason: "not_started",
    worker: null,
    workerReady: false,
    workerScoreVersion: null,
    workerDirtyRegions: [],
    workerPendingRequest: null,
    workerQueuedRequest: null,
    nextWorkerRequestId: 0,
    lastWorkerError: null,
    stats: {
      runs: 0,
      skipped: 0,
      invalidations: 0,
      dirtyPayloads: 0,
      descriptorPayloads: 0,
      recoveries: 0,
      workerRequests: 0,
      workerCoalesced: 0,
      workerFallbacks: 0,
      workerErrors: 0,
      workerStaleResults: 0
    }
  };

  if (preferWorker) {
    try {
      reader.worker = createReaderWorker(reader, scope, workerFactory);

      if (reader.worker) {
        reader.worker.onmessage = (event) => handleWorkerMessage(reader, event);
        reader.worker.onerror = (event) => {
          reader.stats.workerErrors += 1;
          markWorkerUnavailable(
            reader,
            event && event.message ? event.message : "reader worker error"
          );
        };
        initializeWorker(reader);
      }
    } catch (error) {
      reader.lastWorkerError = error && error.message ? error.message : String(error);
      reader.worker = null;
      reader.stats.workerFallbacks += 1;
    }
  }

  return reader;
}

export function invalidateReader(reader, dirtyRegions = []) {
  const regions = normalizeDirtyRegions(dirtyRegions);

  if (regions.length === 0) {
    return null;
  }

  reader.latestDirtyRegions = regions;
  reader.latestDirtyPayload = syncDirtyRegions(reader.scoreSync, regions);
  invalidateDescriptors(reader.analyzer, regions);
  appendWorkerDirtyRegions(reader, regions);
  reader.latestScoreVersionSeen = reader.analyzer.score.version;
  reader.stats.invalidations += 1;

  if (reader.latestDirtyPayload) {
    reader.stats.dirtyPayloads += 1;
  }

  return reader.latestDirtyPayload;
}

export function runReaderEngine(
  reader,
  {
    snapshot,
    dirtyRegions = [],
    nowSeconds = null,
    audioState = getAudioEngineState(reader.audioEngine),
    force = false,
    recover = false
  } = {}
) {
  const regions = normalizeDirtyRegions(dirtyRegions);

  if (regions.length > 0) {
    invalidateReader(reader, regions);
  }

  if (!shouldRunReader(reader, snapshot, regions, audioState, { force, recover })) {
    return createSkippedResult(
      reader,
      snapshot,
      audioState && audioState.status === "ready"
        ? "reader_idle"
        : "audio_not_ready"
    );
  }

  if (reader.worker && reader.workerReady && !force && !recover) {
    const scheduledReason = scheduleWorkerAnalysis(reader, {
      snapshot,
      nowSeconds,
      force,
      recover
    });

    if (scheduledReason) {
      return Object.freeze({
        ran: false,
        pending: true,
        reason: scheduledReason,
        snapshot,
        descriptorPayload: reader.latestDescriptorPayload,
        voiceState: reader.latestVoiceState,
        readerState: getReaderState(reader)
      });
    }
  }

  return syncAnalyzeReader(reader, snapshot, {
    nowSeconds,
    recover,
    reason: recover ? "recover" : force ? "force" : "scheduled"
  });
}

export function getReaderState(reader) {
  return Object.freeze({
    status: reader.status,
    latestScoreVersionSeen: reader.latestScoreVersionSeen,
    latestAnalysisId: reader.latestDescriptorPayload
      ? reader.latestDescriptorPayload.analysisId
      : null,
    latestDescriptorCount: reader.latestDescriptorPayload
      ? reader.latestDescriptorPayload.descriptors.length
      : 0,
    latestDirtyRegionCount: reader.latestDirtyRegions.length,
    latestMotionSnapshot: reader.latestMotionSnapshot,
    latestVoiceState: reader.latestVoiceState,
    lastReconciliationTimeSeconds: reader.lastReconciliationTimeSeconds,
    lastRunReason: reader.lastRunReason,
    backend: Object.freeze({
      mode: reader.worker ? "worker" : "main",
      workerReady: Boolean(reader.workerReady),
      workerPending: Boolean(reader.workerPendingRequest),
      workerScoreVersion: reader.workerScoreVersion,
      lastWorkerError: reader.lastWorkerError
    }),
    stats: Object.freeze({ ...reader.stats })
  });
}

export function destroyReaderEngine(reader) {
  if (!reader || !reader.worker) {
    return;
  }

  try {
    reader.worker.terminate();
  } catch {
    // Nothing to clean up if the worker is already closed.
  }

  reader.worker = null;
  reader.workerReady = false;
  reader.workerPendingRequest = null;
  reader.workerQueuedRequest = null;
}
