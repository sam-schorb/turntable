import { AUDIO_CONFIG } from "./config.js";

export const MESSAGE_TYPES = Object.freeze({
  SET_SAMPLE: "setSample",
  CLEAR_SAMPLE: "clearSample",
  START_VOICE: "startVoice",
  UPDATE_VOICE: "updateVoice",
  STOP_VOICE: "stopVoice",
  STOP_ALL_VOICES: "stopAllVoices",
  SET_MASTER_GAIN: "setMasterGain",
  SET_TRANSPORT: "setTransport",
  SET_LOOP_DEFAULTS: "setLoopDefaults",
  PLAYHEAD_DESCRIPTORS: "playheadDescriptors",
  REQUEST_STATE: "requestState"
});

export const LOOP_MODES = Object.freeze(["inherit", "loop", "noLoop"]);

function assertFiniteNumber(value, name) {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number.`);
  }
}

export function clamp(value, min, max) {
  assertFiniteNumber(value, "value");

  return Math.min(max, Math.max(min, value));
}

export function validateSlotIndex(slotIndex) {
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex > 5) {
    throw new RangeError("slotIndex must be from 0 to 5.");
  }

  return slotIndex;
}

export function validateVoiceId(voiceId) {
  if (typeof voiceId !== "string" || voiceId.trim() === "") {
    throw new TypeError("voiceId must be a non-empty string.");
  }

  return voiceId;
}

export function normalizeLoopMode(loopMode = "inherit") {
  if (!LOOP_MODES.includes(loopMode)) {
    throw new RangeError(`loopMode must be one of ${LOOP_MODES.join(", ")}.`);
  }

  return loopMode;
}

export function clampPlaybackRate(
  playbackRate,
  maxRate = AUDIO_CONFIG.maxEffectivePlaybackRate
) {
  assertFiniteNumber(playbackRate, "effectivePlaybackRate");

  return clamp(playbackRate, -maxRate, maxRate);
}

export function clampAmplitude(
  amplitude,
  maxAmplitude = AUDIO_CONFIG.maxVoiceAmplitude
) {
  assertFiniteNumber(amplitude, "amplitude");

  return clamp(amplitude, 0, maxAmplitude);
}

export function serializeSampleForWorklet(sample) {
  if (
    !sample ||
    !Number.isFinite(sample.sampleRate) ||
    !Number.isInteger(sample.channelCount) ||
    !Number.isInteger(sample.frameCount) ||
    !Array.isArray(sample.channels)
  ) {
    throw new TypeError("sample is invalid.");
  }

  if (sample.channelCount < 1 || sample.channels.length < sample.channelCount) {
    throw new RangeError("sample must contain channel data.");
  }

  const channels = sample.channels
    .slice(0, sample.channelCount)
    .map((channelData) => new Float32Array(channelData));

  return {
    sampleRate: sample.sampleRate,
    channelCount: sample.channelCount,
    frameCount: sample.frameCount,
    durationSeconds: sample.durationSeconds,
    channels
  };
}

export function getTransferListForSample(sample) {
  return sample.channels.map((channelData) => channelData.buffer);
}

export function createSetSampleMessage(slotIndex, sample) {
  validateSlotIndex(slotIndex);

  return {
    type: MESSAGE_TYPES.SET_SAMPLE,
    slotIndex,
    sample: serializeSampleForWorklet(sample)
  };
}

export function createClearSampleMessage(slotIndex) {
  validateSlotIndex(slotIndex);

  return {
    type: MESSAGE_TYPES.CLEAR_SAMPLE,
    slotIndex
  };
}

export function createStartVoiceMessage(voiceSpec) {
  const voiceId = validateVoiceId(voiceSpec.voiceId);
  const slotIndex = validateSlotIndex(voiceSpec.slotIndex);
  const effectivePlaybackRate = clampPlaybackRate(
    voiceSpec.effectivePlaybackRate ?? 1
  );
  const amplitude = clampAmplitude(voiceSpec.amplitude ?? 0.75);
  const loopMode = normalizeLoopMode(voiceSpec.loopMode || "inherit");
  const message = {
    type: MESSAGE_TYPES.START_VOICE,
    voice: {
      voiceId,
      slotIndex,
      effectivePlaybackRate,
      amplitude,
      loopMode,
      gateOpen: voiceSpec.gateOpen !== false
    }
  };

  if (Number.isInteger(voiceSpec.sampleVersion)) {
    message.voice.sampleVersion = voiceSpec.sampleVersion;
  }

  if (voiceSpec.startPhase === "beginning" || voiceSpec.startPhase === "end") {
    message.voice.startPhase = voiceSpec.startPhase;
  }

  if (Number.isFinite(voiceSpec.phaseFrames)) {
    message.voice.phaseFrames = voiceSpec.phaseFrames;
  }

  return message;
}

export function createUpdateVoiceMessage(voiceId, updates) {
  validateVoiceId(voiceId);

  const sanitizedUpdates = {};

  if ("effectivePlaybackRate" in updates) {
    sanitizedUpdates.effectivePlaybackRate = clampPlaybackRate(
      updates.effectivePlaybackRate
    );
  }

  if ("amplitude" in updates) {
    sanitizedUpdates.amplitude = clampAmplitude(updates.amplitude);
  }

  if ("loopMode" in updates) {
    sanitizedUpdates.loopMode = normalizeLoopMode(updates.loopMode);
  }

  if ("gateOpen" in updates) {
    sanitizedUpdates.gateOpen = Boolean(updates.gateOpen);
  }

  return {
    type: MESSAGE_TYPES.UPDATE_VOICE,
    voiceId,
    updates: sanitizedUpdates
  };
}

export function createStopVoiceMessage(
  voiceId,
  fadeMs = AUDIO_CONFIG.fadeOutMs
) {
  validateVoiceId(voiceId);
  assertFiniteNumber(fadeMs, "fadeMs");

  return {
    type: MESSAGE_TYPES.STOP_VOICE,
    voiceId,
    fadeMs: Math.max(0, fadeMs)
  };
}

export function createStopAllVoicesMessage(fadeMs = AUDIO_CONFIG.fadeOutMs) {
  assertFiniteNumber(fadeMs, "fadeMs");

  return {
    type: MESSAGE_TYPES.STOP_ALL_VOICES,
    fadeMs: Math.max(0, fadeMs)
  };
}

export function createSetMasterGainMessage(gain) {
  return {
    type: MESSAGE_TYPES.SET_MASTER_GAIN,
    gain: clamp(gain, 0, 1.5)
  };
}

export function createSetLoopDefaultsMessage({
  globalLoopMode = AUDIO_CONFIG.globalLoopMode,
  slotLoopModes = []
} = {}) {
  return {
    type: MESSAGE_TYPES.SET_LOOP_DEFAULTS,
    globalLoopMode: Boolean(globalLoopMode),
    slotLoopModes: Array.from({ length: 6 }, (_, index) =>
      normalizeLoopMode(slotLoopModes[index] || "inherit")
    )
  };
}

export function createSetTransportMessage(transportSnapshot = {}) {
  return {
    type: MESSAGE_TYPES.SET_TRANSPORT,
    targetGlobalSpeed: Number.isFinite(transportSnapshot.targetGlobalSpeed)
      ? transportSnapshot.targetGlobalSpeed
      : 0,
    actualGlobalSpeed: Number.isFinite(transportSnapshot.actualGlobalSpeed)
      ? transportSnapshot.actualGlobalSpeed
      : 0,
    phaseTurns: Number.isFinite(transportSnapshot.phaseTurns)
      ? transportSnapshot.phaseTurns
      : 0,
    audioTime: Number.isFinite(transportSnapshot.audioTime)
      ? transportSnapshot.audioTime
      : null,
    isPaused: Boolean(transportSnapshot.isPaused),
    isRamping: Boolean(transportSnapshot.isRamping)
  };
}

export function createPlayheadDescriptorsMessage(payload) {
  if (
    !payload ||
    payload.type !== MESSAGE_TYPES.PLAYHEAD_DESCRIPTORS ||
    !Number.isInteger(payload.analysisId) ||
    !Array.isArray(payload.descriptors)
  ) {
    throw new TypeError("playhead descriptor payload is invalid.");
  }

  return {
    type: MESSAGE_TYPES.PLAYHEAD_DESCRIPTORS,
    analysisId: payload.analysisId,
    audioTime: Number.isFinite(payload.audioTime) ? payload.audioTime : null,
    phaseTurns: Number.isFinite(payload.phaseTurns) ? payload.phaseTurns : 0,
    descriptors: payload.descriptors.map((descriptor) => ({
      descriptorId: descriptor.descriptorId,
      colourIndex: descriptor.colourIndex,
      slotIndex: descriptor.slotIndex,
      radialStart: descriptor.radialStart,
      radialEnd: descriptor.radialEnd,
      radialCentre: descriptor.radialCentre,
      coverage: descriptor.coverage,
      strength: descriptor.strength,
      cellCount: descriptor.cellCount,
      weightedCellCount: descriptor.weightedCellCount,
      angularStart: descriptor.angularStart,
      angularEnd: descriptor.angularEnd,
      wrapsAngle: descriptor.wrapsAngle,
      componentHint: descriptor.componentHint,
      rankForColour: descriptor.rankForColour,
      globalRank: descriptor.globalRank
    }))
  };
}
