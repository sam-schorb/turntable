import { SAMPLE_CONFIG } from "./config.js";
import { createDecodeContextProvider } from "./audio-decode.js";
import { createSampleManager } from "./sample-manager.js";
import { createDefaultSampleSlots } from "./sample-slots.js";

export function createAppSampleManager(scope = globalThis) {
  return createSampleManager({
    audioContextProvider: createDecodeContextProvider(scope),
    maxSampleSeconds: SAMPLE_CONFIG.maxSampleSeconds,
    defaultSlots: createDefaultSampleSlots(),
    fetchImpl: scope.fetch ? scope.fetch.bind(scope) : undefined,
    samplePersistence: null
  });
}

export function createInitialSampleState() {
  return Object.freeze({
    status: "six_colour_sample_slots",
    slotCount: 6,
    maxSampleSeconds: SAMPLE_CONFIG.maxSampleSeconds,
    decodedSamplesAvailable: false,
    playbackReady: false
  });
}
