import { APP_CONFIG, AUDIO_CONFIG } from "./config.js";
import { validateSlotLoopMode } from "./sample-slots.js";
import { setLoopState as setVoiceManagerLoopState } from "./voice-manager.js";

function validateSlotIndex(slotIndex, slotCount) {
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= slotCount) {
    throw new RangeError(`slotIndex must be from 0 to ${slotCount - 1}.`);
  }

  return slotIndex;
}

export function createLoopState({
  globalLoopMode = AUDIO_CONFIG.globalLoopMode,
  slotLoopModes = [],
  slotCount = APP_CONFIG.colourCount
} = {}) {
  if (!Number.isInteger(slotCount) || slotCount <= 0) {
    throw new RangeError("slotCount must be a positive integer.");
  }

  return {
    status: "global_and_per_slot_controls",
    globalLoopMode: Boolean(globalLoopMode),
    slotLoopModes: Array.from({ length: slotCount }, (_, index) =>
      validateSlotLoopMode(slotLoopModes[index] || "inherit")
    )
  };
}

export function setGlobalLoopMode(loopState, enabled) {
  loopState.globalLoopMode = Boolean(enabled);

  return getLoopStateSnapshot(loopState);
}

export function setSlotLoopMode(loopState, slotIndex, mode) {
  validateSlotIndex(slotIndex, loopState.slotLoopModes.length);
  loopState.slotLoopModes[slotIndex] = validateSlotLoopMode(mode);

  return getLoopStateSnapshot(loopState);
}

export function getEffectiveLoopMode(loopState, slotIndex) {
  validateSlotIndex(slotIndex, loopState.slotLoopModes.length);

  const slotMode = validateSlotLoopMode(
    loopState.slotLoopModes[slotIndex] || "inherit"
  );

  if (slotMode === "loop") {
    return "loop";
  }

  if (slotMode === "noLoop") {
    return "noLoop";
  }

  return loopState.globalLoopMode ? "loop" : "noLoop";
}

export function getLoopStateSnapshot(loopState) {
  return Object.freeze({
    status: loopState.status,
    globalLoopMode: loopState.globalLoopMode,
    slotLoopModes: loopState.slotLoopModes.slice()
  });
}

export function syncLoopStateToVoices(voiceManager, loopState) {
  return setVoiceManagerLoopState(voiceManager, getLoopStateSnapshot(loopState));
}

export function createInitialLoopState() {
  return getLoopStateSnapshot(createLoopState());
}
