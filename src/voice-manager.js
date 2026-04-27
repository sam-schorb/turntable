import { AUDIO_CONFIG, VOICE_CONFIG } from "./config.js";
import {
  getAudioEngineState,
  startVoice,
  stopVoice,
  updateVoice
} from "./audio-engine.js";
import { getSampleSlot } from "./sample-manager.js";
import { validateSlotLoopMode } from "./sample-slots.js";
import { matchDescriptorsToVoices } from "./voice-matching.js";
import {
  applyNearZeroAmplitudeFade,
  capDescriptors,
  descriptorToAmplitude,
  descriptorToEffectivePlaybackRate,
  resolveLoopMode,
  shouldDeferTrigger
} from "./voice-rules.js";

function createVoiceId(manager) {
  manager.nextVoiceNumber += 1;

  return `voice-${manager.nextVoiceNumber}`;
}

function isAudioReady(manager) {
  return getAudioEngineState(manager.audioEngine).status === "ready";
}

function getSlotLoopMode(manager, slotIndex) {
  return manager.slotLoopModes[slotIndex] || "inherit";
}

function getLoadedSlot(manager, slotIndex) {
  try {
    const slot = getSampleSlot(manager.sampleManager, slotIndex);

    return slot.status === "loaded" && slot.sample ? slot : null;
  } catch {
    return null;
  }
}

function shouldStartNewVoice(transportSnapshot) {
  return !transportSnapshot || transportSnapshot.isPaused !== true;
}

function shouldPlayFullSample(manager) {
  return manager.config && manager.config.playFullSampleOnTrigger === true;
}

function shouldReleaseInsteadOfStop(manager, reason) {
  return (
    shouldPlayFullSample(manager) &&
    (reason === "descriptor-disappeared" || reason === "score-cleared")
  );
}

function cloneVoiceState(voice) {
  return Object.freeze({
    voiceId: voice.voiceId,
    descriptorId: voice.descriptorId,
    componentHint: voice.componentHint,
    slotIndex: voice.slotIndex,
    colourIndex: voice.colourIndex,
    sampleVersion: voice.sampleVersion,
    effectivePlaybackRate: voice.effectivePlaybackRate,
    amplitude: voice.amplitude,
    radialCentre: voice.radialCentre,
    coverage: voice.coverage,
    strength: voice.strength,
    loopMode: voice.loopMode,
    gateOpen: voice.gateOpen,
    lastMatchedAnalysisId: voice.lastMatchedAnalysisId
  });
}

function createVoiceFromDescriptor(manager, descriptor, transportSnapshot) {
  const slot = getLoadedSlot(manager, descriptor.slotIndex);

  if (!slot || !isAudioReady(manager)) {
    return null;
  }

  const effectivePlaybackRate = descriptorToEffectivePlaybackRate(
    descriptor,
    transportSnapshot
  );

  if (shouldDeferTrigger(effectivePlaybackRate)) {
    return null;
  }

  const amplitude = applyNearZeroAmplitudeFade(
    descriptorToAmplitude(descriptor),
    effectivePlaybackRate,
    manager.config
  );
  const loopMode = shouldPlayFullSample(manager)
    ? "noLoop"
    : resolveLoopMode({
        globalLoopMode: manager.globalLoopMode,
        slotLoopMode: getSlotLoopMode(manager, descriptor.slotIndex)
      });
  const playFullSample = shouldPlayFullSample(manager);
  const voiceId = createVoiceId(manager);
  const started = startVoice(manager.audioEngine, {
    voiceId,
    slotIndex: descriptor.slotIndex,
    sampleVersion: slot.version,
    effectivePlaybackRate,
    amplitude,
    loopMode: playFullSample ? "noLoop" : loopMode,
    startPhase: effectivePlaybackRate < 0 ? "end" : "beginning",
    removeAtBoundary: playFullSample
  });

  if (!started) {
    return null;
  }

  const voice = {
    voiceId,
    descriptorId: descriptor.descriptorId,
    componentHint: descriptor.componentHint,
    slotIndex: descriptor.slotIndex,
    colourIndex: descriptor.colourIndex,
    sampleVersion: slot.version,
    effectivePlaybackRate,
    amplitude,
    radialCentre: descriptor.radialCentre,
    coverage: descriptor.coverage,
    strength: descriptor.strength,
    loopMode: playFullSample ? "noLoop" : loopMode,
    playFullSample,
    gateOpen: true,
    lastMatchedAnalysisId: descriptor.analysisId,
    lastDescriptor: descriptor
  };

  manager.activeVoices.set(voiceId, voice);
  manager.stats.started += 1;
  manager.commandLog.push({
    type: "start",
    voiceId,
    descriptorId: descriptor.descriptorId,
    slotIndex: descriptor.slotIndex
  });

  return voice;
}

function updateVoiceFromDescriptor(manager, voice, descriptor, transportSnapshot) {
  const effectivePlaybackRate = descriptorToEffectivePlaybackRate(
    descriptor,
    transportSnapshot
  );
  const amplitude = applyNearZeroAmplitudeFade(
    descriptorToAmplitude(descriptor),
    effectivePlaybackRate,
    manager.config
  );
  const loopMode = shouldPlayFullSample(manager)
    ? "noLoop"
    : resolveLoopMode({
        globalLoopMode: manager.globalLoopMode,
        slotLoopMode: getSlotLoopMode(manager, descriptor.slotIndex)
      });
  const updates = {};

  if (Math.abs(voice.effectivePlaybackRate - effectivePlaybackRate) > 0.000001) {
    updates.effectivePlaybackRate = effectivePlaybackRate;
  }

  if (Math.abs(voice.amplitude - amplitude) > 0.000001) {
    updates.amplitude = amplitude;
  }

  if (voice.loopMode !== loopMode) {
    updates.loopMode = loopMode;
  }

  if (Object.keys(updates).length > 0 && isAudioReady(manager)) {
    updateVoice(manager.audioEngine, voice.voiceId, updates);
    manager.stats.updated += 1;
    manager.commandLog.push({
      type: "update",
      voiceId: voice.voiceId,
      updates
    });
  }

  voice.descriptorId = descriptor.descriptorId;
  voice.componentHint = descriptor.componentHint;
  voice.effectivePlaybackRate = effectivePlaybackRate;
  voice.amplitude = amplitude;
  voice.radialCentre = descriptor.radialCentre;
  voice.coverage = descriptor.coverage;
  voice.strength = descriptor.strength;
  voice.loopMode = loopMode;
  voice.gateOpen = true;
  voice.lastMatchedAnalysisId = descriptor.analysisId;
  voice.lastDescriptor = descriptor;

  return voice;
}

function stopManagedVoice(manager, voice, reason = "missing-descriptor") {
  if (!manager.activeVoices.has(voice.voiceId)) {
    return false;
  }

  if (shouldReleaseInsteadOfStop(manager, reason)) {
    manager.activeVoices.delete(voice.voiceId);
    manager.stats.released += 1;
    manager.commandLog.push({
      type: "release",
      voiceId: voice.voiceId,
      reason
    });
    return true;
  }

  if (isAudioReady(manager)) {
    stopVoice(manager.audioEngine, voice.voiceId, manager.config.fadeOutMs);
  }

  manager.activeVoices.delete(voice.voiceId);
  manager.stats.stopped += 1;
  manager.commandLog.push({
    type: "stop",
    voiceId: voice.voiceId,
    reason
  });

  return true;
}

function normalizeSnapshot(descriptorSnapshot) {
  if (!descriptorSnapshot || !Array.isArray(descriptorSnapshot.descriptors)) {
    return {
      analysisId: 0,
      descriptors: []
    };
  }

  return descriptorSnapshot;
}

export function createVoiceManager({
  audioEngine,
  sampleManager,
  config = VOICE_CONFIG
} = {}) {
  if (!audioEngine || !sampleManager) {
    throw new TypeError("audioEngine and sampleManager are required.");
  }

  return {
    status: "matched_local_island_voices",
    audioEngine,
    sampleManager,
    config,
    activeVoices: new Map(),
    nextVoiceNumber: 0,
    globalLoopMode: AUDIO_CONFIG.globalLoopMode,
    slotLoopModes: Array.from({ length: 6 }, () => "inherit"),
    lastDescriptorSnapshot: null,
    lastTransportSnapshot: null,
    commandLog: [],
    stats: {
      started: 0,
      updated: 0,
      stopped: 0,
      released: 0,
      cappedDescriptors: 0,
      ignoredDescriptors: 0,
      sampleReplacements: 0
    }
  };
}

export function reconcileDescriptors(
  manager,
  descriptorSnapshot,
  transportSnapshot = {}
) {
  const snapshot = normalizeSnapshot(descriptorSnapshot);

  manager.lastDescriptorSnapshot = snapshot;
  manager.lastTransportSnapshot = transportSnapshot;

  if (!isAudioReady(manager)) {
    return getVoiceState(manager);
  }

  const cappedDescriptors = capDescriptors(snapshot.descriptors, manager.config);
  manager.stats.cappedDescriptors +=
    snapshot.descriptors.length - cappedDescriptors.length;

  const activeVoices = Array.from(manager.activeVoices.values());
  const reconciliation = matchDescriptorsToVoices(
    activeVoices,
    cappedDescriptors,
    manager.config
  );

  for (const match of reconciliation.matches) {
    updateVoiceFromDescriptor(
      manager,
      match.voice,
      match.descriptor,
      transportSnapshot
    );
  }

  for (const voice of reconciliation.unmatchedVoices) {
    stopManagedVoice(manager, voice, "descriptor-disappeared");
  }

  for (const descriptor of reconciliation.unmatchedDescriptors) {
    if (!shouldStartNewVoice(transportSnapshot)) {
      manager.stats.ignoredDescriptors += 1;
      continue;
    }

    const voice = createVoiceFromDescriptor(
      manager,
      descriptor,
      transportSnapshot
    );

    if (!voice) {
      manager.stats.ignoredDescriptors += 1;
    }
  }

  return getVoiceState(manager);
}

export function handleSampleReplacement(manager, slotIndex, newSampleVersion) {
  const affectedVoices = Array.from(manager.activeVoices.values()).filter(
    (voice) => voice.slotIndex === slotIndex
  );

  for (const voice of affectedVoices) {
    stopManagedVoice(manager, voice, "sample-replaced");
  }

  manager.stats.sampleReplacements += 1;
  manager.commandLog.push({
    type: "sampleReplacement",
    slotIndex,
    newSampleVersion,
    stoppedVoiceCount: affectedVoices.length
  });

  return {
    stoppedVoiceCount: affectedVoices.length,
    shouldRestart:
      affectedVoices.length > 0 &&
      manager.lastDescriptorSnapshot &&
      manager.lastDescriptorSnapshot.descriptors.some(
        (descriptor) => descriptor.slotIndex === slotIndex
      )
  };
}

export function handleScoreCleared(manager) {
  const voices = Array.from(manager.activeVoices.values());

  for (const voice of voices) {
    stopManagedVoice(manager, voice, "score-cleared");
  }

  return getVoiceState(manager);
}

export function recoverVoicesFromCurrentDescriptors(
  manager,
  descriptorSnapshot,
  transportSnapshot = {}
) {
  const voices = Array.from(manager.activeVoices.values());

  for (const voice of voices) {
    stopManagedVoice(manager, voice, "audio-recovery");
  }

  return reconcileDescriptors(manager, descriptorSnapshot, transportSnapshot);
}

export function setLoopState(
  manager,
  { globalLoopMode = manager.globalLoopMode, slotLoopModes = manager.slotLoopModes } = {}
) {
  manager.globalLoopMode = Boolean(globalLoopMode);
  manager.slotLoopModes = Array.from({ length: 6 }, (_, index) =>
    validateSlotLoopMode(slotLoopModes[index] || "inherit")
  );

  for (const voice of manager.activeVoices.values()) {
    const loopMode = resolveLoopMode({
      globalLoopMode: manager.globalLoopMode,
      slotLoopMode: getSlotLoopMode(manager, voice.slotIndex)
    });

    if (voice.loopMode !== loopMode && isAudioReady(manager)) {
      updateVoice(manager.audioEngine, voice.voiceId, { loopMode });
      voice.loopMode = loopMode;
      manager.stats.updated += 1;
      manager.commandLog.push({
        type: "update",
        voiceId: voice.voiceId,
        updates: { loopMode }
      });
    }
  }

  return getVoiceState(manager);
}

export function getVoiceState(manager) {
  const voices = Array.from(manager.activeVoices.values()).map(cloneVoiceState);

  return Object.freeze({
    status: manager.status,
    activeVoiceCount: voices.length,
    voices,
    globalLoopMode: manager.globalLoopMode,
    slotLoopModes: manager.slotLoopModes.slice(),
    stats: Object.freeze({ ...manager.stats })
  });
}

export function createInitialVoiceState() {
  return Object.freeze({
    status: "matched_local_island_voices",
    activeVoiceCount: 0,
    maxVoicesPerSlot: VOICE_CONFIG.maxVoicesPerSlot,
    maxTotalVoices: VOICE_CONFIG.maxTotalVoices
  });
}
