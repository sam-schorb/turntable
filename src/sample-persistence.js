const DB_NAME = "optical-sample-turntable";
const DB_VERSION = 1;
const STORE_NAME = "custom-samples";

function getIndexedDb(scope = globalThis) {
  return scope && scope.indexedDB ? scope.indexedDB : null;
}

function closeDb(db) {
  if (db && typeof db.close === "function") {
    db.close();
  }
}

function openDatabase(scope = globalThis) {
  const indexedDb = getIndexedDb(scope);

  if (!indexedDb || typeof indexedDb.open !== "function") {
    return Promise.resolve(null);
  }

  return new Promise((resolve, reject) => {
    const request = indexedDb.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "slotIndex" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error || new Error("Could not open sample storage."));
    request.onblocked = () =>
      reject(new Error("Sample storage open was blocked."));
  });
}

function assertSlotIndex(slotIndex) {
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex > 5) {
    throw new RangeError("slotIndex must be an integer from 0 to 5.");
  }
}

function createStoredSampleRecord({
  slotIndex,
  arrayBuffer,
  displayName,
  fullName,
  originalFileName,
  mimeType,
  lastModified
}) {
  assertSlotIndex(slotIndex);

  if (!(arrayBuffer instanceof ArrayBuffer)) {
    throw new TypeError("arrayBuffer must be an ArrayBuffer.");
  }

  return Object.freeze({
    schemaVersion: 1,
    slotIndex,
    displayName: displayName || "Uploaded sample",
    fullName: fullName || displayName || "Uploaded sample",
    originalFileName: originalFileName || null,
    mimeType: mimeType || "",
    lastModified: Number.isFinite(lastModified) ? lastModified : null,
    savedAt: Date.now(),
    byteLength: arrayBuffer.byteLength,
    arrayBuffer: arrayBuffer.slice(0)
  });
}

export function createIndexedDbSamplePersistence(scope = globalThis) {
  return Object.freeze({
    supported: Boolean(getIndexedDb(scope)),

    async loadSlotSample(slotIndex) {
      assertSlotIndex(slotIndex);

      const db = await openDatabase(scope);

      if (!db) {
        return null;
      }

      return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, "readonly");
        const request = transaction.objectStore(STORE_NAME).get(slotIndex);

        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () =>
          reject(request.error || new Error("Could not read saved sample."));
        transaction.oncomplete = () => closeDb(db);
        transaction.onabort = () => {
          closeDb(db);
          reject(transaction.error || new Error("Saved sample read aborted."));
        };
      });
    },

    async saveSlotSample(recordInput) {
      const record = createStoredSampleRecord(recordInput);
      const db = await openDatabase(scope);

      if (!db) {
        return Object.freeze({ stored: false, reason: "unsupported" });
      }

      return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, "readwrite");
        const request = transaction.objectStore(STORE_NAME).put(record);

        request.onerror = () =>
          reject(request.error || new Error("Could not save sample."));
        transaction.oncomplete = () => {
          closeDb(db);
          resolve(
            Object.freeze({
              stored: true,
              slotIndex: record.slotIndex,
              byteLength: record.byteLength
            })
          );
        };
        transaction.onabort = () => {
          closeDb(db);
          reject(transaction.error || new Error("Saved sample write aborted."));
        };
      });
    },

    async deleteSlotSample(slotIndex) {
      assertSlotIndex(slotIndex);

      const db = await openDatabase(scope);

      if (!db) {
        return Object.freeze({ deleted: false, reason: "unsupported" });
      }

      return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, "readwrite");
        const request = transaction.objectStore(STORE_NAME).delete(slotIndex);

        request.onerror = () =>
          reject(request.error || new Error("Could not delete saved sample."));
        transaction.oncomplete = () => {
          closeDb(db);
          resolve(Object.freeze({ deleted: true, slotIndex }));
        };
        transaction.onabort = () => {
          closeDb(db);
          reject(transaction.error || new Error("Saved sample delete aborted."));
        };
      });
    }
  });
}
