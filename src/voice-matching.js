import { VOICE_CONFIG } from "./config.js";

function radialDistance(voice, descriptor) {
  return Math.abs((voice.radialCentre ?? 0) - descriptor.radialCentre);
}

function matchScore(voice, descriptor) {
  const distance = radialDistance(voice, descriptor);
  const hintBonus =
    voice.componentHint && voice.componentHint === descriptor.componentHint
      ? -0.04
      : 0;
  const descriptorBonus =
    voice.descriptorId && voice.descriptorId === descriptor.descriptorId
      ? -0.08
      : 0;

  return distance + hintBonus + descriptorBonus;
}

export function matchDescriptorsToVoices(
  activeVoices,
  descriptors,
  {
    maxMatchRadialDistance = VOICE_CONFIG.maxMatchRadialDistance
  } = {}
) {
  const unmatchedVoices = new Set(activeVoices);
  const unmatchedDescriptors = new Set(descriptors);
  const matches = [];

  for (const descriptor of descriptors) {
    let bestVoice = null;
    let bestScore = Infinity;

    for (const voice of unmatchedVoices) {
      if (
        voice.slotIndex !== descriptor.slotIndex ||
        voice.colourIndex !== descriptor.colourIndex
      ) {
        continue;
      }

      const score = matchScore(voice, descriptor);

      if (score < bestScore) {
        bestScore = score;
        bestVoice = voice;
      }
    }

    if (
      bestVoice &&
      radialDistance(bestVoice, descriptor) <= maxMatchRadialDistance
    ) {
      matches.push({
        voice: bestVoice,
        descriptor,
        distance: radialDistance(bestVoice, descriptor)
      });
      unmatchedVoices.delete(bestVoice);
      unmatchedDescriptors.delete(descriptor);
    }
  }

  return Object.freeze({
    matches,
    unmatchedVoices: Array.from(unmatchedVoices),
    unmatchedDescriptors: Array.from(unmatchedDescriptors)
  });
}
