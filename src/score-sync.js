import { PERFORMANCE_CONFIG } from "./config.js";
import {
  canUseSharedArrayBuffer,
  createSharedScoreBuffer,
  getSharedScoreBufferDiagnostics,
  publishSharedScoreVersion as publishSharedScoreBufferVersion
} from "./shared-score-buffer.js";

export const SCORE_SYNC_MODES = Object.freeze({
  DIRTY_MESSAGE: "dirty-message",
  SHARED_BUFFER: "shared-buffer"
});

function assertScoreGrid(score) {
  if (
    !score ||
    !Number.isInteger(score.angleColumns) ||
    !Number.isInteger(score.radialRows) ||
    !(score.colours instanceof Uint8Array) ||
    !(score.strengths instanceof Uint8Array)
  ) {
    throw new TypeError("score must be a polar score.");
  }
}

function capabilitySupported(capabilities, capabilityId) {
  return Array.isArray(capabilities)
    ? capabilities.some(
        (capability) => capability.id === capabilityId && capability.supported
      )
    : false;
}

function canSelectSharedBuffer(scoreSync, capabilities) {
  if (Array.isArray(capabilities)) {
    return (
      capabilitySupported(capabilities, "cross-origin-isolated") &&
      capabilitySupported(capabilities, "shared-array-buffer")
    );
  }

  return canUseSharedArrayBuffer(scoreSync.scope);
}

function compactDirtyRegion(region) {
  if (!region) {
    return null;
  }

  return Object.freeze({
    editType: region.editType || "unknown",
    minAngleColumn: Number.isInteger(region.minAngleColumn)
      ? region.minAngleColumn
      : 0,
    maxAngleColumn: Number.isInteger(region.maxAngleColumn)
      ? region.maxAngleColumn
      : 0,
    wraps: Boolean(region.wraps),
    minRadialRow: Number.isInteger(region.minRadialRow) ? region.minRadialRow : 0,
    maxRadialRow: Number.isInteger(region.maxRadialRow) ? region.maxRadialRow : 0,
    scoreVersion: Number.isInteger(region.scoreVersion) ? region.scoreVersion : 0,
    fullScore: Boolean(region.fullScore)
  });
}

function compactDescriptor(descriptor) {
  return Object.freeze({
    descriptorId: descriptor.descriptorId,
    colourIndex: descriptor.colourIndex,
    slotIndex: descriptor.slotIndex,
    radialCentre: descriptor.radialCentre,
    coverage: descriptor.coverage,
    strength: descriptor.strength,
    cellCount: descriptor.cellCount,
    rankForColour: descriptor.rankForColour,
    globalRank: descriptor.globalRank
  });
}

export function createScoreSync({
  score,
  analyzer = null,
  audioEngine = null,
  config = PERFORMANCE_CONFIG,
  scope = globalThis
} = {}) {
  assertScoreGrid(score);

  return {
    status: "score_sync_ready",
    score,
    analyzer,
    audioEngine,
    config,
    scope,
    mode: SCORE_SYNC_MODES.DIRTY_MESSAGE,
    sharedScoreBuffer: null,
    sequence: 0,
    lastDirtyPayload: null,
    lastDescriptorPayload: null,
    stats: {
      dirtyPayloads: 0,
      descriptorPayloads: 0,
      sharedPublishes: 0,
      fallbackSelections: 0,
      sharedSelections: 0
    }
  };
}

export function initSharedBuffers(scoreSync) {
  if (!scoreSync.sharedScoreBuffer) {
    scoreSync.sharedScoreBuffer = createSharedScoreBuffer({
      score: scoreSync.score,
      scope: scoreSync.scope,
      pageCount: scoreSync.config.sharedBufferPageCount
    });
  }

  publishSharedScoreBufferVersion(scoreSync.sharedScoreBuffer, scoreSync.score);
  scoreSync.stats.sharedPublishes += 1;

  return scoreSync.sharedScoreBuffer;
}

export function selectSyncMode(scoreSync, capabilities) {
  if (canSelectSharedBuffer(scoreSync, capabilities)) {
    initSharedBuffers(scoreSync);
    scoreSync.mode = SCORE_SYNC_MODES.SHARED_BUFFER;
    scoreSync.stats.sharedSelections += 1;
  } else {
    scoreSync.mode = SCORE_SYNC_MODES.DIRTY_MESSAGE;
    scoreSync.stats.fallbackSelections += 1;
  }

  return getSyncDiagnostics(scoreSync);
}

export function publishSharedScoreVersion(scoreSync) {
  if (!scoreSync.sharedScoreBuffer) {
    initSharedBuffers(scoreSync);
  } else {
    publishSharedScoreBufferVersion(scoreSync.sharedScoreBuffer, scoreSync.score);
    scoreSync.stats.sharedPublishes += 1;
  }

  return getSyncDiagnostics(scoreSync);
}

export function syncDirtyRegions(scoreSync, dirtyRegions = []) {
  const compactRegions = (Array.isArray(dirtyRegions) ? dirtyRegions : [dirtyRegions])
    .map(compactDirtyRegion)
    .filter(Boolean)
    .slice(0, scoreSync.config.maxDirtyRegionsPerPayload);

  if (compactRegions.length === 0) {
    return null;
  }

  scoreSync.sequence += 1;
  scoreSync.stats.dirtyPayloads += 1;

  if (scoreSync.mode === SCORE_SYNC_MODES.SHARED_BUFFER) {
    publishSharedScoreVersion(scoreSync);
  }

  scoreSync.lastDirtyPayload = Object.freeze({
    type: "scoreDirtyRegions",
    mode: scoreSync.mode,
    sequence: scoreSync.sequence,
    scoreVersion: scoreSync.score.version,
    regionCount: compactRegions.length,
    regions: compactRegions
  });

  return scoreSync.lastDirtyPayload;
}

export function syncDescriptorSnapshot(scoreSync, descriptorSnapshot) {
  if (
    !descriptorSnapshot ||
    descriptorSnapshot.type !== "playheadDescriptors" ||
    !Array.isArray(descriptorSnapshot.descriptors)
  ) {
    return null;
  }

  scoreSync.sequence += 1;
  scoreSync.stats.descriptorPayloads += 1;
  scoreSync.lastDescriptorPayload = Object.freeze({
    type: "descriptorSnapshot",
    mode: scoreSync.mode,
    sequence: scoreSync.sequence,
    analysisId: descriptorSnapshot.analysisId,
    phaseTurns: descriptorSnapshot.phaseTurns,
    descriptorCount: descriptorSnapshot.descriptors.length,
    descriptors: descriptorSnapshot.descriptors.map(compactDescriptor)
  });

  return scoreSync.lastDescriptorPayload;
}

export function getSyncDiagnostics(scoreSync) {
  return Object.freeze({
    status: scoreSync.status,
    mode: scoreSync.mode,
    sharedMemoryAvailable: canUseSharedArrayBuffer(scoreSync.scope),
    dirtyMessageFallbackAvailable: true,
    sequence: scoreSync.sequence,
    scoreVersion: scoreSync.score.version,
    lastDirtyRegionCount: scoreSync.lastDirtyPayload
      ? scoreSync.lastDirtyPayload.regionCount
      : 0,
    lastDescriptorCount: scoreSync.lastDescriptorPayload
      ? scoreSync.lastDescriptorPayload.descriptorCount
      : 0,
    stats: Object.freeze({ ...scoreSync.stats }),
    sharedBuffer: getSharedScoreBufferDiagnostics(scoreSync.sharedScoreBuffer)
  });
}

export function createInitialScoreSyncState() {
  return Object.freeze({
    status: "shared_buffer_or_dirty_message_fallback",
    mode: SCORE_SYNC_MODES.DIRTY_MESSAGE,
    dirtyMessageFallbackAvailable: true
  });
}
