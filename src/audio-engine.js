import { AUDIO_CONFIG } from "./config.js";
import {
  createClearSampleMessage,
  createSetLoopDefaultsMessage,
  createSetMasterGainMessage,
  createSetSampleMessage,
  createSetTransportMessage,
  createStartVoiceMessage,
  createPlayheadDescriptorsMessage,
  createStopAllVoicesMessage,
  createStopVoiceMessage,
  createUpdateVoiceMessage,
  getTransferListForSample,
  MESSAGE_TYPES
} from "./audio-messages.js";
import { getSampleSlot, getSampleSlots } from "./sample-manager.js";

function getAudioContextConstructor(scope) {
  return scope.AudioContext || scope.webkitAudioContext || null;
}

function getAudioWorkletNodeConstructor(scope) {
  return scope.AudioWorkletNode || null;
}

function serializeError(error) {
  return error && error.message ? error.message : String(error);
}

function ensureSampleManager(sampleManager) {
  if (!sampleManager || !Array.isArray(sampleManager.slots)) {
    throw new TypeError("sampleManager is required.");
  }
}

function isReady(engine) {
  return Boolean(engine && engine.status === "ready" && engine.workletNode);
}

function postMessage(engine, message, transferList = []) {
  if (!engine || !engine.workletNode || !engine.workletNode.port) {
    return false;
  }

  engine.postedMessages.push(message);
  engine.workletNode.port.postMessage(message, transferList);
  return true;
}

function handleWorkletMessage(engine, event) {
  const message = event && event.data ? event.data : event;

  if (!message || typeof message.type !== "string") {
    return;
  }

  if (message.type === "ready") {
    engine.samplerReady = true;
    return;
  }

  if (message.type === "state") {
    engine.workletState = message.state || null;
    engine.voicesActive = message.state
      ? Number(message.state.voiceCount) || 0
      : engine.voicesActive;
    return;
  }

  if (message.type === "meter") {
    engine.meter = message.meter || null;
    return;
  }

  if (message.type === "voiceEnded") {
    engine.voicesActive = Math.max(0, engine.voicesActive - 1);
    if (message.voiceId === engine.activeTestVoiceId) {
      engine.activeTestVoiceId = null;
    }
    return;
  }

  if (message.type === "error") {
    engine.error = message.message || "Sampler worklet error.";
  }
}

export function createAudioEngine({
  sampleManager,
  scope = globalThis,
  config = AUDIO_CONFIG,
  workletUrl = config.workletUrl
} = {}) {
  ensureSampleManager(sampleManager);

  return {
    status: "locked",
    workletUrl,
    processorName: config.processorName,
    config,
    sampleManager,
    scope,
    audioContext: null,
    workletNode: null,
    masterGainNode: null,
    audioContextCreated: false,
    samplerReady: false,
    voicesActive: 0,
    error: null,
    meter: null,
    workletState: null,
    syncedSampleVersions: new Map(),
    postedMessages: [],
    activeTestVoiceId: null
  };
}

export function getAudioEngineState(engine) {
  return Object.freeze({
    status: engine.status,
    audioContextCreated: engine.audioContextCreated,
    contextState: engine.audioContext && engine.audioContext.state
      ? engine.audioContext.state
      : null,
    samplerReady: engine.samplerReady,
    voicesActive: engine.voicesActive,
    error: engine.error,
    workletUrl: engine.workletUrl,
    meter: engine.meter
  });
}

export async function loadSamplerWorklet(engine) {
  if (!engine || !engine.audioContext) {
    throw new Error("AudioContext must exist before loading the sampler worklet.");
  }

  const { audioContext, scope } = engine;
  const AudioWorkletNodeConstructor = getAudioWorkletNodeConstructor(scope);

  if (
    !audioContext.audioWorklet ||
    typeof audioContext.audioWorklet.addModule !== "function" ||
    !AudioWorkletNodeConstructor
  ) {
    engine.status = "unsupported";
    engine.error = "AudioWorklet is not available in this browser.";
    return false;
  }

  await audioContext.audioWorklet.addModule(engine.workletUrl);

  engine.workletNode = new AudioWorkletNodeConstructor(
    audioContext,
    engine.processorName,
    {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2]
    }
  );

  if (engine.workletNode.port) {
    engine.workletNode.port.onmessage = (event) =>
      handleWorkletMessage(engine, event);
  }

  engine.masterGainNode = audioContext.createGain();
  engine.masterGainNode.gain.value = engine.config.masterGain;
  engine.workletNode.connect(engine.masterGainNode);
  engine.masterGainNode.connect(audioContext.destination);
  engine.samplerReady = true;

  postMessage(engine, createSetMasterGainMessage(engine.config.masterGain));
  postMessage(
    engine,
    createSetLoopDefaultsMessage({
      globalLoopMode: engine.config.globalLoopMode
    })
  );

  return true;
}

export async function unlockAudio(engine) {
  if (!engine) {
    throw new TypeError("audio engine is required.");
  }

  if (isReady(engine)) {
    if (typeof engine.audioContext.resume === "function") {
      await engine.audioContext.resume();
    }
    return getAudioEngineState(engine);
  }

  const AudioContextConstructor = getAudioContextConstructor(engine.scope);

  if (!AudioContextConstructor) {
    engine.status = "unsupported";
    engine.error = "Web Audio is not available in this browser.";
    return getAudioEngineState(engine);
  }

  try {
    engine.status = "loading";
    engine.error = null;
    engine.audioContext = new AudioContextConstructor();
    engine.audioContextCreated = true;

    if (typeof engine.audioContext.resume === "function") {
      await engine.audioContext.resume();
    }

    const loaded = await loadSamplerWorklet(engine);

    if (!loaded) {
      return getAudioEngineState(engine);
    }

    engine.status = "ready";
    await syncAllSampleSlots(engine);
    engine.samplerReady = true;
    return getAudioEngineState(engine);
  } catch (error) {
    engine.status = "error";
    engine.error = serializeError(error);
    return getAudioEngineState(engine);
  }
}

export function syncSampleSlot(engine, slotIndex) {
  if (!isReady(engine)) {
    return false;
  }

  const slot = getSampleSlot(engine.sampleManager, slotIndex);

  if (slot.status !== "loaded" || !slot.sample) {
    postMessage(engine, createClearSampleMessage(slotIndex));
    engine.syncedSampleVersions.delete(slotIndex);
    return true;
  }

  const syncedVersion = engine.syncedSampleVersions.get(slotIndex);

  if (syncedVersion === slot.version) {
    return true;
  }

  const message = createSetSampleMessage(slotIndex, slot.sample);
  const transferList = getTransferListForSample(message.sample);

  postMessage(engine, message, transferList);
  engine.syncedSampleVersions.set(slotIndex, slot.version);
  return true;
}

export async function syncAllSampleSlots(engine) {
  if (!isReady(engine)) {
    return false;
  }

  for (const slot of getSampleSlots(engine.sampleManager)) {
    syncSampleSlot(engine, slot.slotIndex);
  }

  return true;
}

export function startVoice(engine, voiceSpec) {
  if (!isReady(engine)) {
    return false;
  }

  const message = createStartVoiceMessage(voiceSpec);
  const posted = postMessage(engine, message);

  if (posted) {
    engine.voicesActive += 1;
  }

  return posted;
}

export function updateVoice(engine, voiceId, updates) {
  if (!isReady(engine)) {
    return false;
  }

  return postMessage(engine, createUpdateVoiceMessage(voiceId, updates));
}

export function stopVoice(engine, voiceId, fadeMs) {
  if (!isReady(engine)) {
    return false;
  }

  return postMessage(engine, createStopVoiceMessage(voiceId, fadeMs));
}

export function stopAllVoices(engine, fadeMs) {
  if (!isReady(engine)) {
    return false;
  }

  engine.activeTestVoiceId = null;
  engine.voicesActive = 0;
  return postMessage(engine, createStopAllVoicesMessage(fadeMs));
}

export function setMasterGain(engine, gain) {
  if (!engine) {
    return false;
  }

  if (engine.masterGainNode) {
    engine.masterGainNode.gain.value = gain;
  }

  if (!isReady(engine)) {
    return false;
  }

  return postMessage(engine, createSetMasterGainMessage(gain));
}

export function setLoopDefaults(engine, options = {}) {
  if (!isReady(engine)) {
    return false;
  }

  return postMessage(engine, createSetLoopDefaultsMessage(options));
}

export function sendTransportSnapshot(engine, transportSnapshot) {
  if (!isReady(engine)) {
    return false;
  }

  return postMessage(engine, createSetTransportMessage(transportSnapshot));
}

export function requestSamplerState(engine) {
  if (!isReady(engine)) {
    return false;
  }

  return postMessage(engine, { type: MESSAGE_TYPES.REQUEST_STATE });
}

export function sendPlayheadDescriptors(engine, payload) {
  if (!isReady(engine)) {
    return false;
  }

  return postMessage(engine, createPlayheadDescriptorsMessage(payload));
}

export function startControlledTestVoice(engine, slotIndex = 0) {
  const voiceId = `test-${Date.now().toString(36)}`;

  if (engine.activeTestVoiceId) {
    stopVoice(engine, engine.activeTestVoiceId, engine.config.fadeOutMs);
  }

  const started = startVoice(engine, {
    voiceId,
    slotIndex,
    effectivePlaybackRate: 1,
    amplitude: 0.55,
    loopMode: "noLoop"
  });

  if (started) {
    engine.activeTestVoiceId = voiceId;
  }

  return started ? voiceId : null;
}
