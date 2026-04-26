import { SAMPLE_CONFIG, SCORE_PALETTE } from "./config.js";

export const SLOT_LOOP_MODES = Object.freeze(["inherit", "loop", "noLoop"]);

const DEFAULT_SLOT_SPECS = Object.freeze([
  Object.freeze({
    slotIndex: 0,
    colourIndex: 1,
    defaultName: "Kick",
    defaultPath: `${SAMPLE_CONFIG.defaultBasePath}kick.wav`
  }),
  Object.freeze({
    slotIndex: 1,
    colourIndex: 2,
    defaultName: "Bass",
    defaultPath: `${SAMPLE_CONFIG.defaultBasePath}bass.wav`
  }),
  Object.freeze({
    slotIndex: 2,
    colourIndex: 3,
    defaultName: "Hat",
    defaultPath: `${SAMPLE_CONFIG.defaultBasePath}hat.wav`
  }),
  Object.freeze({
    slotIndex: 3,
    colourIndex: 4,
    defaultName: "Clap",
    defaultPath: `${SAMPLE_CONFIG.defaultBasePath}clap.wav`
  }),
  Object.freeze({
    slotIndex: 4,
    colourIndex: 5,
    defaultName: "Blip",
    defaultPath: `${SAMPLE_CONFIG.defaultBasePath}blip.wav`
  }),
  Object.freeze({
    slotIndex: 5,
    colourIndex: 6,
    defaultName: "Bloom",
    defaultPath: `${SAMPLE_CONFIG.defaultBasePath}bloom.wav`
  })
]);

export function cleanSampleDisplayName(fileName, maxLength = 24) {
  if (!fileName || typeof fileName !== "string") {
    return "Untitled";
  }

  const withoutPath = fileName.split(/[\\/]/).at(-1) || fileName;
  const withoutExtension = withoutPath.replace(/\.[a-z0-9]{1,8}$/i, "");
  const cleaned = withoutExtension
    .replace(/[_\-]+/g, " ")
    .replace(/[^a-zA-Z0-9 .()]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const displayName = cleaned || "Untitled";

  if (displayName.length <= maxLength) {
    return displayName;
  }

  return `${displayName.slice(0, Math.max(1, maxLength - 1)).trim()}...`;
}

export function createDefaultSampleSlots(palette = SCORE_PALETTE) {
  return DEFAULT_SLOT_SPECS.map((slot) => {
    const paletteEntry = palette[slot.colourIndex];

    if (!paletteEntry) {
      throw new Error(`Missing palette entry for colour ${slot.colourIndex}.`);
    }

    return {
      slotIndex: slot.slotIndex,
      colourIndex: slot.colourIndex,
      colour: paletteEntry.color,
      defaultName: slot.defaultName,
      displayName: slot.defaultName,
      fullName: slot.defaultName,
      defaultPath: slot.defaultPath,
      sourceType: "default",
      status: "empty",
      durationSeconds: null,
      originalDurationSeconds: null,
      wasTrimmed: false,
      slotLoopMode: "inherit",
      version: 0,
      sample: null,
      message: null,
      error: null,
      pendingSourceName: null,
      originalFileName: null
    };
  });
}

export function getSlotIndexForColourIndex(colourIndex) {
  if (!Number.isInteger(colourIndex) || colourIndex < 1 || colourIndex > 6) {
    return null;
  }

  return colourIndex - 1;
}

export function getColourIndexForSlotIndex(slotIndex) {
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= 6) {
    return null;
  }

  return slotIndex + 1;
}

export function validateSlotLoopMode(slotLoopMode) {
  if (!SLOT_LOOP_MODES.includes(slotLoopMode)) {
    throw new RangeError(`slotLoopMode must be one of ${SLOT_LOOP_MODES.join(", ")}.`);
  }

  return slotLoopMode;
}
