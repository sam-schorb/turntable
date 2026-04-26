import { AUDIO_CONFIG, GEOMETRY_CONFIG, VOICE_CONFIG } from "./config.js";
import { radialMultiplierAtT } from "./geometry.js";

function clamp(value, min, max) {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.min(max, Math.max(min, value));
}

export function validateDescriptorForVoice(descriptor) {
  return Boolean(
    descriptor &&
      Number.isInteger(descriptor.colourIndex) &&
      descriptor.colourIndex >= 1 &&
      descriptor.colourIndex <= 6 &&
      Number.isInteger(descriptor.slotIndex) &&
      descriptor.slotIndex >= 0 &&
      descriptor.slotIndex <= 5 &&
      Number.isFinite(descriptor.radialCentre) &&
      descriptor.radialCentre >= 0 &&
      descriptor.radialCentre <= 1 &&
      Number.isFinite(descriptor.coverage) &&
      descriptor.coverage >= 0 &&
      descriptor.coverage <= 1 &&
      Number.isFinite(descriptor.strength) &&
      descriptor.strength >= 0 &&
      descriptor.strength <= 1
  );
}

export function descriptorPriority(descriptor) {
  return [
    descriptor.globalRank ?? Number.MAX_SAFE_INTEGER,
    descriptor.rankForColour ?? Number.MAX_SAFE_INTEGER,
    -(descriptor.coverage || 0),
    -(descriptor.strength || 0),
    -(descriptor.cellCount || 0),
    descriptor.radialCentre || 0,
    descriptor.descriptorId || ""
  ];
}

function comparePriority(first, second) {
  const firstPriority = descriptorPriority(first);
  const secondPriority = descriptorPriority(second);

  for (let index = 0; index < firstPriority.length; index += 1) {
    if (firstPriority[index] < secondPriority[index]) {
      return -1;
    }

    if (firstPriority[index] > secondPriority[index]) {
      return 1;
    }
  }

  return 0;
}

export function capDescriptors(
  descriptors,
  {
    maxVoicesPerSlot = VOICE_CONFIG.maxVoicesPerSlot,
    maxTotalVoices = VOICE_CONFIG.maxTotalVoices
  } = {}
) {
  const accepted = [];
  const slotCounts = new Map();

  for (const descriptor of descriptors
    .filter(validateDescriptorForVoice)
    .slice()
    .sort(comparePriority)) {
    const slotCount = slotCounts.get(descriptor.slotIndex) || 0;

    if (slotCount >= maxVoicesPerSlot || accepted.length >= maxTotalVoices) {
      continue;
    }

    accepted.push(descriptor);
    slotCounts.set(descriptor.slotIndex, slotCount + 1);
  }

  return accepted;
}

export function radiusToPlaybackMultiplier(
  radialCentre,
  config = GEOMETRY_CONFIG
) {
  return radialMultiplierAtT(clamp(radialCentre, 0, 1), config);
}

export function descriptorToEffectivePlaybackRate(
  descriptor,
  transportSnapshot,
  {
    maxEffectivePlaybackRate = AUDIO_CONFIG.maxEffectivePlaybackRate,
    geometryConfig = GEOMETRY_CONFIG
  } = {}
) {
  const actualGlobalSpeed =
    transportSnapshot && Number.isFinite(transportSnapshot.actualGlobalSpeed)
      ? transportSnapshot.actualGlobalSpeed
      : 0;
  const radialMultiplier = radiusToPlaybackMultiplier(
    descriptor.radialCentre,
    geometryConfig
  );

  return clamp(
    actualGlobalSpeed * radialMultiplier,
    -maxEffectivePlaybackRate,
    maxEffectivePlaybackRate
  );
}

export function descriptorToAmplitude(
  descriptor,
  {
    amplitudeCurve = VOICE_CONFIG.amplitudeCurve,
    coverageWeight = VOICE_CONFIG.amplitudeCoverageWeight,
    strengthWeight = VOICE_CONFIG.amplitudeStrengthWeight,
    minAudibleAmplitude = VOICE_CONFIG.minAudibleAmplitude,
    maxAmplitude = AUDIO_CONFIG.maxVoiceAmplitude
  } = {}
) {
  const coverage = clamp(descriptor.coverage, 0, 1);
  const strength = clamp(descriptor.strength, 0, 1);
  const weightedInput = clamp(
    coverage * coverageWeight + strength * strengthWeight,
    0,
    1
  );

  if (weightedInput <= 0) {
    return 0;
  }

  const curved = 1 - Math.exp(-amplitudeCurve * weightedInput);
  const normalized = minAudibleAmplitude + curved * (1 - minAudibleAmplitude);

  return clamp(normalized, 0, maxAmplitude);
}

export function applyNearZeroAmplitudeFade(
  amplitude,
  effectivePlaybackRate,
  { minAudiblePlaybackRate = VOICE_CONFIG.minAudiblePlaybackRate } = {}
) {
  if (
    !Number.isFinite(effectivePlaybackRate) ||
    Math.abs(effectivePlaybackRate) < minAudiblePlaybackRate
  ) {
    return 0;
  }

  return amplitude;
}

export function resolveLoopMode({
  globalLoopMode = AUDIO_CONFIG.globalLoopMode,
  slotLoopMode = "inherit"
} = {}) {
  if (slotLoopMode === "loop") {
    return "loop";
  }

  if (slotLoopMode === "noLoop") {
    return "noLoop";
  }

  return globalLoopMode ? "loop" : "noLoop";
}

export function shouldDeferTrigger(effectivePlaybackRate) {
  return (
    !Number.isFinite(effectivePlaybackRate) ||
    Math.abs(effectivePlaybackRate) < VOICE_CONFIG.minTriggerPlaybackRate
  );
}
