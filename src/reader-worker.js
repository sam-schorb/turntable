import {
  analyzePlayhead,
  createPlayheadAnalyzer
} from "./playhead-analyzer.js";
import { createScore } from "./score.js";

const state = {
  score: null,
  analyzer: null,
  geometry: null
};

function rebuildNonEmptyIndices(score) {
  score.nonEmptyIndices.clear();

  for (let index = 0; index < score.colours.length; index += 1) {
    if (score.colours[index] !== 0 && score.strengths[index] > 0) {
      score.nonEmptyIndices.add(index);
    }
  }
}

function createWorkerScore(update) {
  const score = createScore({
    angleColumns: update.angleColumns,
    radialRows: update.radialRows,
    colourCount: update.colourCount
  });

  score.colours.set(update.colours);
  score.strengths.set(update.strengths);
  score.version = Number.isInteger(update.scoreVersion)
    ? update.scoreVersion
    : 0;
  rebuildNonEmptyIndices(score);

  return score;
}

function applyFullScoreUpdate(update) {
  if (
    !state.score ||
    state.score.angleColumns !== update.angleColumns ||
    state.score.radialRows !== update.radialRows ||
    state.score.colourCount !== update.colourCount
  ) {
    state.score = createWorkerScore(update);
    state.analyzer = null;
    return;
  }

  state.score.colours.set(update.colours);
  state.score.strengths.set(update.strengths);
  state.score.version = Number.isInteger(update.scoreVersion)
    ? update.scoreVersion
    : state.score.version;
  rebuildNonEmptyIndices(state.score);
}

function applyPatchScoreUpdate(update) {
  if (!state.score) {
    throw new Error("reader worker patch arrived before score initialization.");
  }

  for (let offset = 0; offset < update.indices.length; offset += 1) {
    const index = update.indices[offset];
    const colourIndex = update.colours[offset];
    const strength = colourIndex === 0 ? 0 : update.strengths[offset];

    state.score.colours[index] = colourIndex;
    state.score.strengths[index] = strength;

    if (colourIndex === 0 || strength === 0) {
      state.score.nonEmptyIndices.delete(index);
    } else {
      state.score.nonEmptyIndices.add(index);
    }
  }

  if (Number.isInteger(update.scoreVersion)) {
    state.score.version = update.scoreVersion;
  }
}

function applyScoreUpdate(update) {
  if (!update) {
    return;
  }

  if (update.type === "full") {
    applyFullScoreUpdate(update);
    return;
  }

  if (update.type === "patch") {
    applyPatchScoreUpdate(update);
  }
}

function updateGeometry(geometry) {
  if (!geometry) {
    return;
  }

  state.geometry = geometry;

  if (state.analyzer) {
    state.analyzer.geometry = geometry;
  }
}

function ensureAnalyzer() {
  if (!state.score || !state.geometry) {
    return null;
  }

  if (!state.analyzer) {
    state.analyzer = createPlayheadAnalyzer({
      score: state.score,
      geometry: state.geometry
    });
  }

  return state.analyzer;
}

function handleInit(message) {
  applyScoreUpdate(message.scoreUpdate);
  updateGeometry(message.geometry);
  ensureAnalyzer();

  globalThis.postMessage({
    type: "initialized",
    scoreVersion: state.score ? state.score.version : null
  });
}

function handleAnalyze(message) {
  applyScoreUpdate(message.scoreUpdate);
  updateGeometry(message.geometry);

  const analyzer = ensureAnalyzer();

  if (!analyzer) {
    globalThis.postMessage({
      type: "analysisResult",
      requestId: message.requestId,
      payload: null,
      scoreVersion: state.score ? state.score.version : null,
      reason: "reader worker missing score or geometry"
    });
    return;
  }

  const payload = analyzePlayhead(analyzer, message.transportSnapshot, {
    geometry: state.geometry
  });

  globalThis.postMessage({
    type: "analysisResult",
    requestId: message.requestId,
    payload,
    scoreVersion: state.score.version
  });
}

globalThis.onmessage = (event) => {
  const message = event && event.data ? event.data : event;

  try {
    if (!message || typeof message.type !== "string") {
      return;
    }

    if (message.type === "init") {
      handleInit(message);
      return;
    }

    if (message.type === "analyze") {
      handleAnalyze(message);
    }
  } catch (error) {
    globalThis.postMessage({
      type: "error",
      requestId: message && message.requestId,
      message: error && error.message ? error.message : String(error)
    });
  }
};
