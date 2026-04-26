import { SAMPLE_CONFIG } from "./config.js";
import {
  decodeSampleArrayBuffer,
  trimDecodedSample
} from "./audio-decode.js";
import {
  cleanSampleDisplayName,
  createDefaultSampleSlots,
  validateSlotLoopMode
} from "./sample-slots.js";

function validateSlotIndex(sampleManager, slotIndex) {
  if (
    !Number.isInteger(slotIndex) ||
    slotIndex < 0 ||
    slotIndex >= sampleManager.slots.length
  ) {
    throw new RangeError(
      `slotIndex must be from 0 to ${sampleManager.slots.length - 1}.`
    );
  }
}

function serializeError(error) {
  return error && error.message ? error.message : String(error);
}

function isArrayBuffer(value) {
  return value instanceof ArrayBuffer;
}

function applyDecodedSample(slot, decodedSample, metadata) {
  const oldVersion = slot.version;

  slot.sample = decodedSample;
  slot.durationSeconds = decodedSample.durationSeconds;
  slot.originalDurationSeconds = decodedSample.originalDurationSeconds;
  slot.wasTrimmed = decodedSample.wasTrimmed;
  slot.displayName = metadata.displayName;
  slot.fullName = metadata.fullName || metadata.displayName;
  slot.sourceType = metadata.sourceType;
  slot.status = "loaded";
  slot.version += 1;
  slot.message = decodedSample.wasTrimmed
    ? `Using first ${metadata.maxSampleSeconds} seconds.`
    : metadata.message || null;
  slot.error = null;
  slot.pendingSourceName = null;
  slot.originalFileName = metadata.originalFileName || null;

  return Object.freeze({
    type: "sample-replaced",
    slotIndex: slot.slotIndex,
    oldVersion,
    newVersion: slot.version,
    sample: slot.sample
  });
}

export function createSampleManager({
  audioContextProvider,
  maxSampleSeconds = SAMPLE_CONFIG.maxSampleSeconds,
  defaultSlots = createDefaultSampleSlots(),
  fetchImpl = globalThis.fetch,
  samplePersistence = null
} = {}) {
  if (typeof audioContextProvider !== "function") {
    throw new TypeError("audioContextProvider is required.");
  }

  if (!Number.isFinite(maxSampleSeconds) || maxSampleSeconds <= 0) {
    throw new RangeError("maxSampleSeconds must be greater than 0.");
  }

  return {
    status: "six_colour_sample_slots",
    audioContextProvider,
    maxSampleSeconds,
    fetchImpl,
    samplePersistence,
    slots: defaultSlots.map((slot) => ({ ...slot })),
    replacementEvents: [],
    persistenceErrors: []
  };
}

export function getSampleSlot(sampleManager, slotIndex) {
  validateSlotIndex(sampleManager, slotIndex);

  return sampleManager.slots[slotIndex];
}

export function getSampleSlots(sampleManager) {
  return sampleManager.slots.slice();
}

export function setSampleSlotLoopMode(sampleManager, slotIndex, slotLoopMode) {
  validateSlotIndex(sampleManager, slotIndex);

  const slot = sampleManager.slots[slotIndex];

  slot.slotLoopMode = validateSlotLoopMode(slotLoopMode);

  return slot;
}

export async function readFileAsArrayBuffer(file) {
  if (!file) {
    return null;
  }

  if (typeof file.arrayBuffer !== "function") {
    throw new TypeError("file must expose arrayBuffer().");
  }

  return file.arrayBuffer();
}

export async function decodeAndTrimSample(sampleManager, arrayBuffer) {
  const decodedSample = await decodeSampleArrayBuffer(
    sampleManager.audioContextProvider,
    arrayBuffer
  );

  return trimDecodedSample(decodedSample, sampleManager.maxSampleSeconds);
}

async function loadPersistedSlotSample(sampleManager, slot) {
  const persistence = sampleManager.samplePersistence;

  if (!persistence || typeof persistence.loadSlotSample !== "function") {
    return null;
  }

  try {
    const record = await persistence.loadSlotSample(slot.slotIndex);

    if (!record || !isArrayBuffer(record.arrayBuffer)) {
      return null;
    }

    const decodedSample = await decodeAndTrimSample(
      sampleManager,
      record.arrayBuffer
    );
    const displayName =
      record.displayName ||
      cleanSampleDisplayName(record.originalFileName || slot.defaultName);
    const event = applyDecodedSample(slot, decodedSample, {
      displayName,
      fullName: record.fullName || record.originalFileName || displayName,
      sourceType: "upload",
      maxSampleSeconds: sampleManager.maxSampleSeconds,
      originalFileName: record.originalFileName || null
    });

    sampleManager.replacementEvents.push(event);

    return event;
  } catch (error) {
    sampleManager.persistenceErrors.push({
      type: "load-persisted-sample-failed",
      slotIndex: slot.slotIndex,
      error: serializeError(error)
    });

    return null;
  }
}

async function loadDefaultSlotSample(sampleManager, slot) {
  const response = await sampleManager.fetchImpl(slot.defaultPath);

  if (!response || !response.ok) {
    throw new Error(`Could not load ${slot.defaultPath}.`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const decodedSample = await decodeAndTrimSample(sampleManager, arrayBuffer);
  const event = applyDecodedSample(slot, decodedSample, {
    displayName: slot.defaultName,
    fullName: slot.defaultName,
    sourceType: "default",
    maxSampleSeconds: sampleManager.maxSampleSeconds
  });

  sampleManager.replacementEvents.push(event);

  return event;
}

export async function loadDefaultSamples(sampleManager) {
  if (typeof sampleManager.fetchImpl !== "function") {
    throw new TypeError("fetchImpl is required to load default samples.");
  }

  const results = await Promise.allSettled(
    sampleManager.slots.map(async (slot) => {
      slot.status = "loading";
      slot.message = "Loading default";
      slot.error = null;

      try {
        return (
          (await loadPersistedSlotSample(sampleManager, slot)) ||
          (await loadDefaultSlotSample(sampleManager, slot))
        );
      } catch (error) {
        slot.status = "error";
        slot.message = "Default unavailable";
        slot.error = serializeError(error);
        slot.pendingSourceName = null;
        return null;
      }
    })
  );

  return results.map((result) =>
    result.status === "fulfilled" ? result.value : null
  );
}

async function persistUploadedSample(sampleManager, slotIndex, file, arrayBuffer, metadata) {
  const persistence = sampleManager.samplePersistence;

  if (!persistence || typeof persistence.saveSlotSample !== "function") {
    return null;
  }

  try {
    return await persistence.saveSlotSample({
      slotIndex,
      arrayBuffer,
      displayName: metadata.displayName,
      fullName: metadata.fullName,
      originalFileName: metadata.originalFileName,
      mimeType: file.type || "",
      lastModified: file.lastModified
    });
  } catch (error) {
    sampleManager.persistenceErrors.push({
      type: "save-uploaded-sample-failed",
      slotIndex,
      error: serializeError(error)
    });

    return null;
  }
}

export async function replaceSlotSample(sampleManager, slotIndex, file) {
  validateSlotIndex(sampleManager, slotIndex);

  if (!file) {
    return Object.freeze({
      type: "sample-replace-cancelled",
      slotIndex
    });
  }

  const slot = getSampleSlot(sampleManager, slotIndex);
  const previousState = {
    status: slot.status,
    message: slot.message,
    error: slot.error,
    pendingSourceName: slot.pendingSourceName
  };
  const displayName = cleanSampleDisplayName(file.name || "Uploaded sample");

  slot.status = "loading";
  slot.message = "Decoding";
  slot.error = null;
  slot.pendingSourceName = displayName;

  try {
    const arrayBuffer = await readFileAsArrayBuffer(file);

    if (!arrayBuffer) {
      slot.status = previousState.status;
      slot.message = previousState.message;
      slot.error = previousState.error;
      slot.pendingSourceName = previousState.pendingSourceName;

      return Object.freeze({
        type: "sample-replace-cancelled",
        slotIndex
      });
    }

    const decodedSample = await decodeAndTrimSample(sampleManager, arrayBuffer);
    const metadata = {
      displayName,
      fullName: file.name || displayName,
      sourceType: "upload",
      maxSampleSeconds: sampleManager.maxSampleSeconds,
      originalFileName: file.name || null
    };
    const event = applyDecodedSample(slot, decodedSample, {
      ...metadata
    });

    await persistUploadedSample(
      sampleManager,
      slotIndex,
      file,
      arrayBuffer,
      metadata
    );
    sampleManager.replacementEvents.push(event);

    return event;
  } catch (error) {
    slot.status = slot.sample ? "loaded" : previousState.status || "error";
    slot.message = "Could not decode file";
    slot.error = serializeError(error);
    slot.pendingSourceName = null;

    return Object.freeze({
      type: "sample-replace-failed",
      slotIndex,
      error: slot.error
    });
  }
}
