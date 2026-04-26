const PROCESSOR_NAME = "turntable-sampler";
const MAX_EFFECTIVE_PLAYBACK_RATE = 8;
const AMP_SMOOTH_MS = 10;
const RATE_SMOOTH_MS = 10;
const DEFAULT_FADE_OUT_MS = 4;
const OUTPUT_LIMIT = 0.98;
const MIN_AUDIBLE_RATE = 0.0001;

function clamp(value, min, max) {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.min(max, Math.max(min, value));
}

function normalizeLoopMode(loopMode) {
  return loopMode === "loop" || loopMode === "noLoop" ? loopMode : "inherit";
}

function smoothTowards(current, target, coefficient) {
  if (!Number.isFinite(current)) {
    return target;
  }

  return current + (target - current) * coefficient;
}

function getSmoothingCoefficient(milliseconds) {
  const samples = Math.max(1, (milliseconds / 1000) * sampleRate);

  return 1 - Math.exp(-1 / samples);
}

function isValidSlotIndex(slotIndex) {
  return Number.isInteger(slotIndex) && slotIndex >= 0 && slotIndex <= 5;
}

function isValidSample(sample) {
  return (
    sample &&
    Number.isFinite(sample.sampleRate) &&
    Number.isInteger(sample.channelCount) &&
    Number.isInteger(sample.frameCount) &&
    sample.sampleRate > 0 &&
    sample.channelCount > 0 &&
    sample.frameCount > 0 &&
    Array.isArray(sample.channels) &&
    sample.channels.length >= sample.channelCount &&
    sample.channels
      .slice(0, sample.channelCount)
      .every((channel) => channel instanceof Float32Array)
  );
}

function createVoice(voiceSpec, sample) {
  const sampleFrameCount = sample.frameCount;
  const targetRate = clamp(
    voiceSpec.effectivePlaybackRate ?? 1,
    -MAX_EFFECTIVE_PLAYBACK_RATE,
    MAX_EFFECTIVE_PLAYBACK_RATE
  );
  const phaseFrames = Number.isFinite(voiceSpec.phaseFrames)
    ? clamp(voiceSpec.phaseFrames, 0, sampleFrameCount - 1)
    : targetRate < 0
      ? sampleFrameCount - 1
      : 0;
  const amplitude = clamp(voiceSpec.amplitude ?? 0.75, 0, 1);

  return {
    voiceId: voiceSpec.voiceId,
    slotIndex: voiceSpec.slotIndex,
    sample,
    sampleVersion: Number.isInteger(voiceSpec.sampleVersion)
      ? voiceSpec.sampleVersion
      : null,
    phaseFrames,
    targetRate,
    smoothedRate: targetRate,
    targetAmplitude: amplitude,
    smoothedAmplitude: amplitude,
    loopMode: normalizeLoopMode(voiceSpec.loopMode),
    gateOpen: voiceSpec.gateOpen !== false,
    silentAtBoundary: false,
    boundarySide: null,
    fading: false,
    fadeSamplesRemaining: 0,
    fadeSamplesTotal: 0,
    endedPosted: false
  };
}

class SamplerWorkletProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    this.samples = new Map();
    this.voices = new Map();
    this.masterGain = 0.75;
    this.globalLoopMode = false;
    this.slotLoopModes = Array.from({ length: 6 }, () => "inherit");
    this.lastPlayheadDescriptors = null;
    this.lastTransportSnapshot = null;
    this.rateCoefficient = getSmoothingCoefficient(RATE_SMOOTH_MS);
    this.ampCoefficient = getSmoothingCoefficient(AMP_SMOOTH_MS);
    this.port.onmessage = (event) => this.handleMessage(event.data);
    this.port.postMessage({ type: "ready" });
  }

  handleMessage(message) {
    try {
      if (!message || typeof message.type !== "string") {
        return;
      }

      switch (message.type) {
        case "setSample":
          this.setSample(message.slotIndex, message.sample);
          break;
        case "clearSample":
          this.clearSample(message.slotIndex);
          break;
        case "startVoice":
          this.startVoice(message.voice);
          break;
        case "updateVoice":
          this.updateVoice(message.voiceId, message.updates || {});
          break;
        case "stopVoice":
          this.stopVoice(message.voiceId, message.fadeMs);
          break;
        case "stopAllVoices":
          this.stopAllVoices(message.fadeMs);
          break;
        case "setMasterGain":
          this.masterGain = clamp(message.gain, 0, 1.5);
          break;
        case "setTransport":
          this.setTransport(message);
          break;
        case "setLoopDefaults":
          this.setLoopDefaults(message);
          break;
        case "playheadDescriptors":
          this.lastPlayheadDescriptors = {
            analysisId: message.analysisId,
            audioTime: Number.isFinite(message.audioTime)
              ? message.audioTime
              : null,
            phaseTurns: Number.isFinite(message.phaseTurns)
              ? message.phaseTurns
              : 0,
            descriptorCount: Array.isArray(message.descriptors)
              ? message.descriptors.length
              : 0
          };
          break;
        case "requestState":
          this.postState();
          break;
        default:
          break;
      }
    } catch (error) {
      this.port.postMessage({
        type: "error",
        message: error && error.message ? error.message : String(error)
      });
    }
  }

  setSample(slotIndex, sample) {
    if (!isValidSlotIndex(slotIndex) || !isValidSample(sample)) {
      return;
    }

    this.samples.set(slotIndex, sample);
  }

  clearSample(slotIndex) {
    if (!isValidSlotIndex(slotIndex)) {
      return;
    }

    this.samples.delete(slotIndex);

    for (const [voiceId, voice] of this.voices.entries()) {
      if (voice.slotIndex === slotIndex) {
        this.voices.delete(voiceId);
        this.postVoiceEnded(voice, "sample-cleared");
      }
    }
  }

  startVoice(voiceSpec) {
    if (
      !voiceSpec ||
      typeof voiceSpec.voiceId !== "string" ||
      voiceSpec.voiceId.trim() === "" ||
      !isValidSlotIndex(voiceSpec.slotIndex)
    ) {
      return;
    }

    const sample = this.samples.get(voiceSpec.slotIndex);

    if (!sample) {
      return;
    }

    this.voices.set(
      voiceSpec.voiceId,
      createVoice(voiceSpec, sample)
    );
  }

  updateVoice(voiceId, updates) {
    const voice = this.voices.get(voiceId);

    if (!voice) {
      return;
    }

    if ("effectivePlaybackRate" in updates) {
      voice.targetRate = clamp(
        updates.effectivePlaybackRate,
        -MAX_EFFECTIVE_PLAYBACK_RATE,
        MAX_EFFECTIVE_PLAYBACK_RATE
      );
    }

    if ("amplitude" in updates) {
      voice.targetAmplitude = clamp(updates.amplitude, 0, 1);
    }

    if ("loopMode" in updates) {
      voice.loopMode = normalizeLoopMode(updates.loopMode);
    }

    if ("gateOpen" in updates) {
      voice.gateOpen = Boolean(updates.gateOpen);
      if (!voice.gateOpen) {
        this.stopVoice(voiceId, DEFAULT_FADE_OUT_MS);
      }
    }
  }

  stopVoice(voiceId, fadeMs = DEFAULT_FADE_OUT_MS) {
    const voice = this.voices.get(voiceId);

    if (!voice) {
      return;
    }

    const fadeSamples = Math.max(
      0,
      Math.ceil((Math.max(0, fadeMs) / 1000) * sampleRate)
    );

    if (fadeSamples === 0) {
      this.voices.delete(voiceId);
      this.postVoiceEnded(voice, "stopped");
      return;
    }

    voice.fading = true;
    voice.fadeSamplesRemaining = fadeSamples;
    voice.fadeSamplesTotal = fadeSamples;
  }

  stopAllVoices(fadeMs = DEFAULT_FADE_OUT_MS) {
    for (const voiceId of this.voices.keys()) {
      this.stopVoice(voiceId, fadeMs);
    }
  }

  setLoopDefaults(message) {
    this.globalLoopMode = Boolean(message.globalLoopMode);

    if (Array.isArray(message.slotLoopModes)) {
      this.slotLoopModes = Array.from({ length: 6 }, (_, index) =>
        normalizeLoopMode(message.slotLoopModes[index])
      );
    }
  }

  setTransport(message) {
    this.lastTransportSnapshot = {
      targetGlobalSpeed: Number.isFinite(message.targetGlobalSpeed)
        ? message.targetGlobalSpeed
        : 0,
      actualGlobalSpeed: Number.isFinite(message.actualGlobalSpeed)
        ? message.actualGlobalSpeed
        : 0,
      phaseTurns: Number.isFinite(message.phaseTurns) ? message.phaseTurns : 0,
      audioTime: Number.isFinite(message.audioTime) ? message.audioTime : null,
      isPaused: Boolean(message.isPaused),
      isRamping: Boolean(message.isRamping)
    };
  }

  postState() {
    this.port.postMessage({
      type: "state",
      state: {
        sampleCount: this.samples.size,
        voiceCount: this.voices.size,
        masterGain: this.masterGain,
        globalLoopMode: this.globalLoopMode,
        lastTransportSnapshot: this.lastTransportSnapshot,
        lastPlayheadDescriptors: this.lastPlayheadDescriptors
      }
    });
  }

  postVoiceEnded(voice, reason) {
    if (!voice || voice.endedPosted) {
      return;
    }

    voice.endedPosted = true;
    this.port.postMessage({
      type: "voiceEnded",
      voiceId: voice.voiceId,
      reason
    });
  }

  resolveLooping(voice) {
    const slotMode = this.slotLoopModes[voice.slotIndex] || "inherit";

    if (voice.loopMode === "loop" || slotMode === "loop") {
      return true;
    }

    if (voice.loopMode === "noLoop" || slotMode === "noLoop") {
      return false;
    }

    return this.globalLoopMode;
  }

  readSample(sample, phaseFrames, channelIndex) {
    const channelCount = sample.channelCount;
    const sourceChannel =
      sample.channels[channelCount === 1 ? 0 : channelIndex % channelCount];
    const maxFrame = sample.frameCount - 1;
    const lowerFrame = Math.floor(clamp(phaseFrames, 0, maxFrame));
    const upperFrame = Math.min(maxFrame, lowerFrame + 1);
    const fraction = phaseFrames - lowerFrame;
    const lowerValue = sourceChannel[lowerFrame] || 0;
    const upperValue = sourceChannel[upperFrame] || 0;

    return lowerValue + (upperValue - lowerValue) * fraction;
  }

  updateBoundaryState(voice, sample, looping) {
    const maxFrame = sample.frameCount - 1;

    if (looping) {
      while (voice.phaseFrames >= sample.frameCount) {
        voice.phaseFrames -= sample.frameCount;
      }
      while (voice.phaseFrames < 0) {
        voice.phaseFrames += sample.frameCount;
      }
      voice.silentAtBoundary = false;
      voice.boundarySide = null;
      voice.endedPosted = false;
      return;
    }

    if (voice.silentAtBoundary) {
      const movingForwardFromEnd =
        voice.boundarySide === "end" && voice.smoothedRate > 0;
      const movingReverseFromStart =
        voice.boundarySide === "start" && voice.smoothedRate < 0;

      if (movingForwardFromEnd || movingReverseFromStart) {
        return;
      }

      voice.silentAtBoundary = false;
      voice.boundarySide = null;
      voice.endedPosted = false;
    }

    if (voice.phaseFrames >= maxFrame) {
      voice.phaseFrames = maxFrame;

      if (voice.smoothedRate > 0) {
        voice.silentAtBoundary = true;
        voice.boundarySide = "end";
        this.postVoiceEnded(voice, "boundary");
      }
    } else if (voice.phaseFrames <= 0) {
      voice.phaseFrames = 0;

      if (voice.smoothedRate < 0) {
        voice.silentAtBoundary = true;
        voice.boundarySide = "start";
        this.postVoiceEnded(voice, "boundary");
      }
    }
  }

  processVoiceFrame(voice, sample, outputLeft, outputRight, frameIndex) {
    voice.smoothedRate = smoothTowards(
      voice.smoothedRate,
      voice.targetRate,
      this.rateCoefficient
    );
    voice.smoothedAmplitude = smoothTowards(
      voice.smoothedAmplitude,
      voice.targetAmplitude,
      this.ampCoefficient
    );

    if (Math.abs(voice.smoothedRate) < MIN_AUDIBLE_RATE) {
      return;
    }

    const looping = this.resolveLooping(voice);

    this.updateBoundaryState(voice, sample, looping);

    if (voice.silentAtBoundary) {
      return;
    }

    let fadeGain = 1;

    if (voice.fading) {
      fadeGain = voice.fadeSamplesRemaining / voice.fadeSamplesTotal;
      voice.fadeSamplesRemaining -= 1;

      if (voice.fadeSamplesRemaining <= 0) {
        this.voices.delete(voice.voiceId);
        this.postVoiceEnded(voice, "stopped");
      }
    }

    const amplitude = voice.smoothedAmplitude * fadeGain;
    outputLeft[frameIndex] +=
      this.readSample(sample, voice.phaseFrames, 0) * amplitude;
    outputRight[frameIndex] +=
      this.readSample(sample, voice.phaseFrames, 1) * amplitude;

    voice.phaseFrames += voice.smoothedRate * (sample.sampleRate / sampleRate);
  }

  processVoiceBlock(voice, sample, outputLeft, outputRight) {
    const channelCount = sample.channelCount;
    const leftSource = sample.channels[0];
    const rightSource =
      sample.channels[channelCount === 1 ? 0 : 1 % channelCount];
    const frameCount = sample.frameCount;
    const maxFrame = frameCount - 1;
    const sampleRateRatio = sample.sampleRate / sampleRate;
    const rateCoefficient = this.rateCoefficient;
    const ampCoefficient = this.ampCoefficient;
    const looping = this.resolveLooping(voice);
    const outputLength = outputLeft.length;
    const targetRate = voice.targetRate;
    const targetAmplitude = voice.targetAmplitude;
    const fading = voice.fading;
    const fadeSamplesTotal = voice.fadeSamplesTotal;
    let phaseFrames = voice.phaseFrames;
    let smoothedRate = voice.smoothedRate;
    let smoothedAmplitude = voice.smoothedAmplitude;
    let silentAtBoundary = voice.silentAtBoundary;
    let boundarySide = voice.boundarySide;
    let endedPosted = voice.endedPosted;
    let fadeSamplesRemaining = voice.fadeSamplesRemaining;
    let voiceDeleted = false;

    for (let frameIndex = 0; frameIndex < outputLength; frameIndex += 1) {
      smoothedRate += (targetRate - smoothedRate) * rateCoefficient;
      smoothedAmplitude +=
        (targetAmplitude - smoothedAmplitude) * ampCoefficient;

      if (Math.abs(smoothedRate) < MIN_AUDIBLE_RATE) {
        continue;
      }

      if (looping) {
        while (phaseFrames >= frameCount) {
          phaseFrames -= frameCount;
        }
        while (phaseFrames < 0) {
          phaseFrames += frameCount;
        }
        silentAtBoundary = false;
        boundarySide = null;
        endedPosted = false;
      } else {
        if (silentAtBoundary) {
          const movingForwardFromEnd =
            boundarySide === "end" && smoothedRate > 0;
          const movingReverseFromStart =
            boundarySide === "start" && smoothedRate < 0;

          if (movingForwardFromEnd || movingReverseFromStart) {
            continue;
          }

          silentAtBoundary = false;
          boundarySide = null;
          endedPosted = false;
          voice.endedPosted = false;
        }

        if (phaseFrames >= maxFrame) {
          phaseFrames = maxFrame;

          if (smoothedRate > 0) {
            silentAtBoundary = true;
            boundarySide = "end";
            voice.endedPosted = endedPosted;
            this.postVoiceEnded(voice, "boundary");
            endedPosted = voice.endedPosted;
          }
        } else if (phaseFrames <= 0) {
          phaseFrames = 0;

          if (smoothedRate < 0) {
            silentAtBoundary = true;
            boundarySide = "start";
            voice.endedPosted = endedPosted;
            this.postVoiceEnded(voice, "boundary");
            endedPosted = voice.endedPosted;
          }
        }
      }

      if (silentAtBoundary) {
        continue;
      }

      let fadeGain = 1;

      if (fading) {
        fadeGain = fadeSamplesRemaining / fadeSamplesTotal;
        fadeSamplesRemaining -= 1;

        if (fadeSamplesRemaining <= 0) {
          this.voices.delete(voice.voiceId);
          voice.endedPosted = endedPosted;
          this.postVoiceEnded(voice, "stopped");
          endedPosted = voice.endedPosted;
          voiceDeleted = true;
        }
      }

      let clampedPhaseFrames = phaseFrames;

      if (clampedPhaseFrames < 0 || !Number.isFinite(clampedPhaseFrames)) {
        clampedPhaseFrames = 0;
      } else if (clampedPhaseFrames > maxFrame) {
        clampedPhaseFrames = maxFrame;
      }

      const lowerFrame = Math.floor(clampedPhaseFrames);
      const upperFrame =
        lowerFrame >= maxFrame ? maxFrame : lowerFrame + 1;
      const fraction = phaseFrames - lowerFrame;
      const leftLowerValue = leftSource[lowerFrame] || 0;
      const leftUpperValue = leftSource[upperFrame] || 0;
      const rightLowerValue = rightSource[lowerFrame] || 0;
      const rightUpperValue = rightSource[upperFrame] || 0;
      const amplitude = smoothedAmplitude * fadeGain;

      outputLeft[frameIndex] +=
        (leftLowerValue + (leftUpperValue - leftLowerValue) * fraction) *
        amplitude;
      outputRight[frameIndex] +=
        (rightLowerValue + (rightUpperValue - rightLowerValue) * fraction) *
        amplitude;

      phaseFrames += smoothedRate * sampleRateRatio;

      if (voiceDeleted) {
        break;
      }
    }

    voice.phaseFrames = phaseFrames;
    voice.smoothedRate = smoothedRate;
    voice.smoothedAmplitude = smoothedAmplitude;
    voice.silentAtBoundary = silentAtBoundary;
    voice.boundarySide = boundarySide;
    voice.endedPosted = endedPosted;
    voice.fadeSamplesRemaining = fadeSamplesRemaining;
  }

  process(inputs, outputs) {
    const output = outputs[0];
    const outputLeft = output[0];
    const outputRight = output[1] || output[0];

    outputLeft.fill(0);
    outputRight.fill(0);

    for (const voice of Array.from(this.voices.values())) {
      const sample = voice.sample || this.samples.get(voice.slotIndex);

      if (!sample) {
        this.voices.delete(voice.voiceId);
        this.postVoiceEnded(voice, "sample-missing");
        continue;
      }

      this.processVoiceBlock(voice, sample, outputLeft, outputRight);
    }

    const masterGain = this.masterGain;

    for (let index = 0; index < outputLeft.length; index += 1) {
      let leftValue = outputLeft[index] * masterGain;
      let rightValue = outputRight[index] * masterGain;

      if (!Number.isFinite(leftValue) || leftValue < -OUTPUT_LIMIT) {
        leftValue = -OUTPUT_LIMIT;
      } else if (leftValue > OUTPUT_LIMIT) {
        leftValue = OUTPUT_LIMIT;
      }

      if (!Number.isFinite(rightValue) || rightValue < -OUTPUT_LIMIT) {
        rightValue = -OUTPUT_LIMIT;
      } else if (rightValue > OUTPUT_LIMIT) {
        rightValue = OUTPUT_LIMIT;
      }

      outputLeft[index] = leftValue;
      outputRight[index] = rightValue;
    }

    return true;
  }
}

registerProcessor(PROCESSOR_NAME, SamplerWorkletProcessor);
