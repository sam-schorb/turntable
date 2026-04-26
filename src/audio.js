import { AUDIO_CONFIG } from "./config.js";
import { createAudioEngine } from "./audio-engine.js";

export function createAppAudioEngine({ sampleManager, scope = globalThis } = {}) {
  return createAudioEngine({
    sampleManager,
    scope,
    config: AUDIO_CONFIG,
    workletUrl: AUDIO_CONFIG.workletUrl
  });
}

export function createInitialAudioState() {
  return Object.freeze({
    status: "playhead_driven_sampler",
    audioContextCreated: false,
    samplerReady: false,
    voicesActive: 0,
    workletUrl: AUDIO_CONFIG.workletUrl
  });
}
