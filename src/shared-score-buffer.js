export const SHARED_SCORE_META = Object.freeze({
  sequence: 0,
  activePage: 1,
  publishedVersion: 2,
  angleColumns: 3,
  radialRows: 4,
  cellCount: 5,
  pageCount: 6,
  lastWriteCellCount: 7
});

function assertScoreGrid(score) {
  if (
    !score ||
    !Number.isInteger(score.angleColumns) ||
    !Number.isInteger(score.radialRows) ||
    !(score.colours instanceof Uint8Array) ||
    !(score.strengths instanceof Uint8Array)
  ) {
    throw new TypeError("score must be a polar score with colour and strength arrays.");
  }
}

function getSharedArrayBufferConstructor(scope = globalThis) {
  return typeof scope.SharedArrayBuffer === "function"
    ? scope.SharedArrayBuffer
    : null;
}

export function canUseSharedArrayBuffer(scope = globalThis) {
  return Boolean(
    scope &&
      scope.crossOriginIsolated === true &&
      getSharedArrayBufferConstructor(scope)
  );
}

export function createSharedScoreBuffer({
  score,
  scope = globalThis,
  pageCount = 2
} = {}) {
  assertScoreGrid(score);

  const SharedArrayBufferConstructor = getSharedArrayBufferConstructor(scope);

  if (!SharedArrayBufferConstructor || scope.crossOriginIsolated !== true) {
    throw new Error(
      "SharedArrayBuffer score sync requires crossOriginIsolated and SharedArrayBuffer."
    );
  }

  if (!Number.isInteger(pageCount) || pageCount < 2) {
    throw new RangeError("pageCount must be an integer greater than or equal to 2.");
  }

  const cellCount = score.angleColumns * score.radialRows;
  const metaBuffer = new SharedArrayBufferConstructor(
    Int32Array.BYTES_PER_ELEMENT * 8
  );
  const colourBuffer = new SharedArrayBufferConstructor(cellCount * pageCount);
  const strengthBuffer = new SharedArrayBufferConstructor(cellCount * pageCount);
  const meta = new Int32Array(metaBuffer);
  const colourPages = Array.from(
    { length: pageCount },
    (_, pageIndex) =>
      new Uint8Array(colourBuffer, pageIndex * cellCount, cellCount)
  );
  const strengthPages = Array.from(
    { length: pageCount },
    (_, pageIndex) =>
      new Uint8Array(strengthBuffer, pageIndex * cellCount, cellCount)
  );

  Atomics.store(meta, SHARED_SCORE_META.sequence, 0);
  Atomics.store(meta, SHARED_SCORE_META.activePage, 0);
  Atomics.store(meta, SHARED_SCORE_META.publishedVersion, -1);
  Atomics.store(meta, SHARED_SCORE_META.angleColumns, score.angleColumns);
  Atomics.store(meta, SHARED_SCORE_META.radialRows, score.radialRows);
  Atomics.store(meta, SHARED_SCORE_META.cellCount, cellCount);
  Atomics.store(meta, SHARED_SCORE_META.pageCount, pageCount);
  Atomics.store(meta, SHARED_SCORE_META.lastWriteCellCount, 0);

  return {
    status: "shared_score_buffer_ready",
    metaBuffer,
    colourBuffer,
    strengthBuffer,
    meta,
    colourPages,
    strengthPages,
    cellCount,
    pageCount
  };
}

export function publishSharedScoreVersion(sharedScoreBuffer, score) {
  assertScoreGrid(score);

  if (!sharedScoreBuffer || !(sharedScoreBuffer.meta instanceof Int32Array)) {
    throw new TypeError("sharedScoreBuffer is required.");
  }

  const cellCount = score.angleColumns * score.radialRows;

  if (cellCount !== sharedScoreBuffer.cellCount) {
    throw new RangeError("score dimensions do not match shared buffer dimensions.");
  }

  const meta = sharedScoreBuffer.meta;
  const activePage = Atomics.load(meta, SHARED_SCORE_META.activePage);
  const writePage = (activePage + 1) % sharedScoreBuffer.pageCount;

  Atomics.add(meta, SHARED_SCORE_META.sequence, 1);
  sharedScoreBuffer.colourPages[writePage].set(score.colours);
  sharedScoreBuffer.strengthPages[writePage].set(score.strengths);
  Atomics.store(meta, SHARED_SCORE_META.lastWriteCellCount, cellCount);
  Atomics.store(meta, SHARED_SCORE_META.publishedVersion, score.version);
  Atomics.store(meta, SHARED_SCORE_META.activePage, writePage);
  Atomics.add(meta, SHARED_SCORE_META.sequence, 1);

  return getSharedScoreBufferDiagnostics(sharedScoreBuffer);
}

export function getPublishedScoreViews(sharedScoreBuffer) {
  if (!sharedScoreBuffer || !(sharedScoreBuffer.meta instanceof Int32Array)) {
    throw new TypeError("sharedScoreBuffer is required.");
  }

  const activePage = Atomics.load(
    sharedScoreBuffer.meta,
    SHARED_SCORE_META.activePage
  );

  return Object.freeze({
    sequence: Atomics.load(sharedScoreBuffer.meta, SHARED_SCORE_META.sequence),
    scoreVersion: Atomics.load(
      sharedScoreBuffer.meta,
      SHARED_SCORE_META.publishedVersion
    ),
    activePage,
    colours: sharedScoreBuffer.colourPages[activePage],
    strengths: sharedScoreBuffer.strengthPages[activePage]
  });
}

export function getSharedScoreBufferDiagnostics(sharedScoreBuffer) {
  if (!sharedScoreBuffer || !(sharedScoreBuffer.meta instanceof Int32Array)) {
    return Object.freeze({
      status: "shared_score_buffer_unavailable",
      available: false
    });
  }

  return Object.freeze({
    status: sharedScoreBuffer.status,
    available: true,
    sequence: Atomics.load(sharedScoreBuffer.meta, SHARED_SCORE_META.sequence),
    activePage: Atomics.load(sharedScoreBuffer.meta, SHARED_SCORE_META.activePage),
    publishedVersion: Atomics.load(
      sharedScoreBuffer.meta,
      SHARED_SCORE_META.publishedVersion
    ),
    angleColumns: Atomics.load(
      sharedScoreBuffer.meta,
      SHARED_SCORE_META.angleColumns
    ),
    radialRows: Atomics.load(
      sharedScoreBuffer.meta,
      SHARED_SCORE_META.radialRows
    ),
    cellCount: sharedScoreBuffer.cellCount,
    pageCount: sharedScoreBuffer.pageCount
  });
}
