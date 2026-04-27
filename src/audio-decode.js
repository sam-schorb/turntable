import { SAMPLE_CONFIG } from "./config.js";

function assertArrayBuffer(arrayBuffer) {
  if (!(arrayBuffer instanceof ArrayBuffer)) {
    throw new TypeError("arrayBuffer must be an ArrayBuffer.");
  }
}

function assertPositiveNumber(value, name) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive number.`);
  }
}

export function createDecodeContextProvider(scope = globalThis) {
  let context = null;

  return function getDecodeContext() {
    if (context) {
      return context;
    }

    const OfflineAudioContextConstructor =
      scope.OfflineAudioContext || scope.webkitOfflineAudioContext;

    if (OfflineAudioContextConstructor) {
      context = new OfflineAudioContextConstructor(1, 1, 48000);
      return context;
    }

    throw new Error("Offline Web Audio decoding is unavailable.");
  };
}

export async function decodeSampleArrayBuffer(audioContextProvider, arrayBuffer) {
  assertArrayBuffer(arrayBuffer);

  if (typeof audioContextProvider !== "function") {
    throw new TypeError("audioContextProvider must be a function.");
  }

  const context = audioContextProvider();

  if (!context || typeof context.decodeAudioData !== "function") {
    throw new Error("decodeAudioData is unavailable.");
  }

  const decodeInput = arrayBuffer.slice(0);
  const audioBuffer = await context.decodeAudioData(decodeInput);

  return normalizeAudioBuffer(audioBuffer);
}

export function normalizeAudioBuffer(audioBuffer) {
  if (
    !audioBuffer ||
    !Number.isFinite(audioBuffer.sampleRate) ||
    !Number.isInteger(audioBuffer.numberOfChannels) ||
    !Number.isInteger(audioBuffer.length) ||
    typeof audioBuffer.getChannelData !== "function"
  ) {
    throw new TypeError("audioBuffer does not expose decoded channel data.");
  }

  if (audioBuffer.numberOfChannels <= 0) {
    throw new RangeError("decoded sample must contain at least one channel.");
  }

  if (audioBuffer.length <= 0) {
    throw new RangeError("decoded sample must contain at least one frame.");
  }

  const channels = [];

  for (
    let channelIndex = 0;
    channelIndex < audioBuffer.numberOfChannels;
    channelIndex += 1
  ) {
    channels.push(new Float32Array(audioBuffer.getChannelData(channelIndex)));
  }

  return Object.freeze({
    sampleRate: audioBuffer.sampleRate,
    channelCount: audioBuffer.numberOfChannels,
    frameCount: audioBuffer.length,
    durationSeconds: audioBuffer.length / audioBuffer.sampleRate,
    originalDurationSeconds: audioBuffer.length / audioBuffer.sampleRate,
    channels,
    wasTrimmed: false
  });
}

export function trimDecodedSample(
  decodedSample,
  maxSampleSeconds = SAMPLE_CONFIG.maxSampleSeconds
) {
  if (
    !decodedSample ||
    !Number.isFinite(decodedSample.sampleRate) ||
    !Number.isInteger(decodedSample.frameCount) ||
    !Array.isArray(decodedSample.channels)
  ) {
    throw new TypeError("decodedSample is invalid.");
  }

  if (maxSampleSeconds == null) {
    return decodedSample;
  }

  assertPositiveNumber(maxSampleSeconds, "maxSampleSeconds");

  const maxFrameCount = Math.floor(
    decodedSample.sampleRate * maxSampleSeconds
  );
  const frameCount = Math.min(decodedSample.frameCount, maxFrameCount);
  const wasTrimmed = decodedSample.frameCount > frameCount;
  const channels = decodedSample.channels.map(
    (channelData) => new Float32Array(channelData.slice(0, frameCount))
  );

  return Object.freeze({
    sampleRate: decodedSample.sampleRate,
    channelCount: decodedSample.channelCount,
    frameCount,
    durationSeconds: frameCount / decodedSample.sampleRate,
    originalDurationSeconds:
      decodedSample.originalDurationSeconds ??
      decodedSample.frameCount / decodedSample.sampleRate,
    channels,
    wasTrimmed
  });
}

export function formatDurationSeconds(durationSeconds) {
  if (!Number.isFinite(durationSeconds)) {
    return "";
  }

  if (durationSeconds < 10) {
    return `${durationSeconds.toFixed(1)}s`;
  }

  return `${Math.round(durationSeconds)}s`;
}
