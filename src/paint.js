import { BRUSH_CONFIG, SCORE_PALETTE } from "./config.js";
import {
  measurePointerSpeed,
  smoothBrushRadius,
  stampBrush
} from "./brush.js";
import {
  TAU,
  clientPointToDiscPoint,
  discPointToPlayablePolar,
  normalizeTurns,
  screenPolarToScorePolar
} from "./geometry.js";
import {
  appendDirtyRegion,
  createDirtyRegion,
  createFullScoreDirtyRegion
} from "./dirty-regions.js";
import { clearScore } from "./score.js";
import { getTransportSnapshot } from "./transport.js";

const VALID_TOOLS = new Set(["paint", "erase", "none"]);

function assertValidColourIndex(controller, colourIndex) {
  if (
    !Number.isInteger(colourIndex) ||
    colourIndex < 1 ||
    colourIndex > controller.colourCount
  ) {
    throw new RangeError(
      `colourIndex must be an integer from 1 to ${controller.colourCount}.`
    );
  }
}

function assertValidTool(tool) {
  if (!VALID_TOOLS.has(tool)) {
    throw new RangeError(`tool must be one of ${Array.from(VALID_TOOLS).join(", ")}.`);
  }
}

function nowSecondsFallback(nowSeconds) {
  return Number.isFinite(nowSeconds) ? nowSeconds : performance.now() / 1000;
}

function getGeometry(controller) {
  return controller.getGeometry ? controller.getGeometry() : controller.geometry;
}

function createPointerSample(controller, pointerState, nowSeconds) {
  const geometry = getGeometry(controller);
  const canvas = pointerState.canvas || controller.canvas;

  if (!geometry || !canvas) {
    return null;
  }

  const discPoint = clientPointToDiscPoint(
    canvas,
    pointerState.clientX,
    pointerState.clientY,
    geometry
  );

  return {
    pointerId: pointerState.pointerId,
    clientX: pointerState.clientX,
    clientY: pointerState.clientY,
    x: discPoint.x,
    y: discPoint.y,
    discPoint,
    timeSeconds: nowSecondsFallback(nowSeconds)
  };
}

function pointerSampleToScorePolar(controller, pointerSample, nowSeconds) {
  const geometry = getGeometry(controller);
  const screenPolar = discPointToPlayablePolar(geometry, pointerSample.discPoint);

  if (!screenPolar) {
    return null;
  }

  return screenPolarToScorePolar(
    getTransportSnapshot(controller.transport, nowSeconds),
    screenPolar,
    geometry
  );
}

function pointerSampleToActiveStrokeScorePolar(
  controller,
  pointerSample,
  nowSeconds,
  fallbackScorePolar
) {
  const scorePolar = pointerSampleToScorePolar(
    controller,
    pointerSample,
    nowSeconds
  );

  if (scorePolar) {
    return scorePolar;
  }

  const geometry = getGeometry(controller);
  const discPoint = pointerSample.discPoint;

  if (
    !geometry ||
    !discPoint ||
    !Number.isFinite(discPoint.radius) ||
    discPoint.radius >= geometry.innerPlayableRadius
  ) {
    return null;
  }

  if (discPoint.radius <= 0 && fallbackScorePolar) {
    return fallbackScorePolar;
  }

  return screenPolarToScorePolar(
    getTransportSnapshot(controller.transport, nowSeconds),
    {
      angleTurns: normalizeTurns(Math.atan2(discPoint.y, discPoint.x) / TAU),
      radialT: 0,
      radius: geometry.innerPlayableRadius
    },
    geometry
  );
}

function appendStampDirtyRegion(controller, affectedCells, editType) {
  return appendDirtyRegion(
    controller.dirtyRegions,
    createDirtyRegion(controller.score, affectedCells, editType)
  );
}

function stampScorePolar(controller, scorePolar, brushRadius) {
  if (!scorePolar) {
    return {
      mutationCount: 0,
      dirtyRegion: null
    };
  }

  if (
    controller.tool === "none" ||
    (controller.tool === "paint" &&
      !Number.isInteger(controller.selectedColourIndex))
  ) {
    return {
      mutationCount: 0,
      dirtyRegion: null
    };
  }

  const geometry = getGeometry(controller);
  const editMode = {
    tool: controller.tool,
    colourIndex: controller.selectedColourIndex
  };
  const result = stampBrush(
    controller.score,
    geometry,
    scorePolar,
    brushRadius,
    editMode
  );
  const dirtyRegion = appendStampDirtyRegion(
    controller,
    result.affectedCells,
    controller.tool
  );

  return {
    mutationCount: result.mutationCount,
    dirtyRegion
  };
}

function stampPointerSample(controller, pointerSample, nowSeconds, brushRadius) {
  return stampScorePolar(
    controller,
    pointerSampleToScorePolar(controller, pointerSample, nowSeconds),
    brushRadius
  );
}

function turnDeltaShortestPath(fromTurns, toTurns) {
  return ((toTurns - fromTurns + 0.5) % 1 + 1) % 1 - 0.5;
}

function radialTToRadius(geometry, radialT) {
  return (
    geometry.innerPlayableRadius +
    Math.min(1, Math.max(0, radialT)) *
      (geometry.outerRadius - geometry.innerPlayableRadius)
  );
}

function scorePolarToCartesian(geometry, scorePolar) {
  const radius = radialTToRadius(geometry, scorePolar.radialT);
  const angleRadians = normalizeTurns(scorePolar.angleTurns) * TAU;

  return {
    x: Math.cos(angleRadians) * radius,
    y: Math.sin(angleRadians) * radius
  };
}

function interpolateScorePolar(previousScorePolar, nextScorePolar, t) {
  return {
    angleTurns: normalizeTurns(
      previousScorePolar.angleTurns +
        turnDeltaShortestPath(
          previousScorePolar.angleTurns,
          nextScorePolar.angleTurns
        ) *
          t
    ),
    radialT:
      previousScorePolar.radialT +
      (nextScorePolar.radialT - previousScorePolar.radialT) * t,
    radius:
      previousScorePolar.radius +
      (nextScorePolar.radius - previousScorePolar.radius) * t
  };
}

function scorePolarDistance(geometry, previousScorePolar, nextScorePolar) {
  const previousPoint = scorePolarToCartesian(geometry, previousScorePolar);
  const nextPoint = scorePolarToCartesian(geometry, nextScorePolar);

  return Math.hypot(nextPoint.x - previousPoint.x, nextPoint.y - previousPoint.y);
}

function stampScorePolarSegment(controller, previousScorePolar, nextScorePolar) {
  if (!previousScorePolar || !nextScorePolar) {
    const stampResult = stampScorePolar(
      controller,
      nextScorePolar,
      controller.brushRadius
    );

    return stampResult.mutationCount;
  }

  const geometry = getGeometry(controller);
  const distance = scorePolarDistance(geometry, previousScorePolar, nextScorePolar);
  const spacing = Math.max(
    1,
    controller.brushRadius * controller.brushConfig.stampSpacingRatio
  );
  const steps = Math.max(1, Math.ceil(distance / spacing));
  let mutationCount = 0;

  for (let step = 1; step <= steps; step += 1) {
    const stampResult = stampScorePolar(
      controller,
      interpolateScorePolar(previousScorePolar, nextScorePolar, step / steps),
      controller.brushRadius
    );

    mutationCount += stampResult.mutationCount;
  }

  return mutationCount;
}

function createStationaryPointerSample(pointerSample, nowSeconds) {
  return {
    ...pointerSample,
    timeSeconds: nowSeconds
  };
}

export function createPaintController({
  score,
  transport,
  geometry,
  getGeometry: geometryGetter,
  canvas,
  brushConfig = BRUSH_CONFIG,
  palette = SCORE_PALETTE
}) {
  if (!score || !transport) {
    throw new TypeError("score and transport are required.");
  }

  return {
    status: "paint_erase_clear",
    score,
    transport,
    geometry,
    getGeometry: geometryGetter,
    canvas,
    brushConfig,
    palette,
    colourCount: palette.length - 1,
    selectedColourIndex: 1,
    tool: "paint",
    brushRadius: null,
    pointerSpeed: 0,
    activeStroke: null,
    dirtyRegions: []
  };
}

export function setSelectedColour(controller, colourIndex) {
  assertValidColourIndex(controller, colourIndex);

  controller.selectedColourIndex = colourIndex;

  return controller;
}

export function setTool(controller, tool) {
  assertValidTool(tool);

  controller.tool = tool;

  return controller;
}

export function clearPaintToolSelection(controller) {
  controller.tool = "none";
  controller.selectedColourIndex = null;

  return controller;
}

export function beginStroke(controller, pointerState, nowSeconds) {
  if (controller.activeStroke) {
    return {
      started: false,
      reason: "stroke_already_active"
    };
  }

  if (
    controller.tool === "none" ||
    (controller.tool === "paint" &&
      !Number.isInteger(controller.selectedColourIndex))
  ) {
    return {
      started: false,
      reason: "no_paint_tool_selected"
    };
  }

  const resolvedNowSeconds = nowSecondsFallback(nowSeconds);
  const pointerSample = createPointerSample(
    controller,
    pointerState,
    resolvedNowSeconds
  );

  if (!pointerSample) {
    return {
      started: false,
      reason: "missing_geometry"
    };
  }

  const scorePolar = pointerSampleToScorePolar(
    controller,
    pointerSample,
    resolvedNowSeconds
  );

  if (!scorePolar) {
    return {
      started: false,
      reason: "outside_playable_annulus"
    };
  }

  controller.brushRadius = smoothBrushRadius(
    controller.brushRadius,
    0,
    controller.brushConfig,
    getGeometry(controller)
  );
  controller.pointerSpeed = 0;
  controller.activeStroke = {
    pointerId: pointerState.pointerId,
    currentPointer: pointerSample,
    currentScorePolar: scorePolar,
    lastMovementPointer: pointerSample
  };

  const stampResult = stampScorePolar(
    controller,
    scorePolar,
    controller.brushRadius
  );

  return {
    started: true,
    mutationCount: stampResult.mutationCount,
    dirtyRegion: stampResult.dirtyRegion
  };
}

export function updateStroke(controller, pointerState, nowSeconds) {
  const stroke = controller.activeStroke;

  if (!stroke || stroke.pointerId !== pointerState.pointerId) {
    return {
      updated: false,
      reason: "inactive_pointer"
    };
  }

  const resolvedNowSeconds = nowSecondsFallback(nowSeconds);
  const nextPointer = createPointerSample(
    controller,
    pointerState,
    resolvedNowSeconds
  );

  if (!nextPointer) {
    return {
      updated: false,
      reason: "missing_geometry"
    };
  }

  controller.pointerSpeed = measurePointerSpeed(
    stroke.lastMovementPointer,
    nextPointer
  );
  controller.brushRadius = smoothBrushRadius(
    controller.brushRadius,
    controller.pointerSpeed,
    controller.brushConfig,
    getGeometry(controller)
  );

  const nextStrokeScorePolar = pointerSampleToActiveStrokeScorePolar(
    controller,
    nextPointer,
    resolvedNowSeconds,
    stroke.currentScorePolar
  );
  const mutationCount = stampScorePolarSegment(
    controller,
    stroke.currentScorePolar,
    nextStrokeScorePolar
  );

  stroke.currentPointer = nextPointer;
  stroke.currentScorePolar = nextStrokeScorePolar;
  stroke.lastMovementPointer = nextPointer;

  return {
    updated: true,
    pointerSpeed: controller.pointerSpeed,
    brushRadius: controller.brushRadius,
    mutationCount
  };
}

export function tickStroke(controller, nowSeconds) {
  const stroke = controller.activeStroke;

  if (!stroke) {
    return {
      ticked: false,
      reason: "no_active_stroke"
    };
  }

  const resolvedNowSeconds = nowSecondsFallback(nowSeconds);
  const stationaryPointer = createStationaryPointerSample(
    stroke.currentPointer,
    resolvedNowSeconds
  );

  controller.pointerSpeed = measurePointerSpeed(
    stroke.lastMovementPointer,
    stationaryPointer
  );
  controller.brushRadius = smoothBrushRadius(
    controller.brushRadius,
    controller.pointerSpeed,
    controller.brushConfig,
    getGeometry(controller)
  );

  const nextStrokeScorePolar = pointerSampleToActiveStrokeScorePolar(
    controller,
    stationaryPointer,
    resolvedNowSeconds,
    stroke.currentScorePolar
  );
  const mutationCount = stampScorePolarSegment(
    controller,
    stroke.currentScorePolar,
    nextStrokeScorePolar
  );

  stroke.currentPointer = stationaryPointer;
  stroke.currentScorePolar = nextStrokeScorePolar;

  return {
    ticked: true,
    pointerSpeed: controller.pointerSpeed,
    brushRadius: controller.brushRadius,
    mutationCount,
    dirtyRegion: controller.dirtyRegions.at(-1) || null
  };
}

export function endStroke(controller, pointerState, nowSeconds) {
  const stroke = controller.activeStroke;

  if (!stroke || (pointerState && stroke.pointerId !== pointerState.pointerId)) {
    return {
      ended: false,
      reason: "inactive_pointer"
    };
  }

  tickStroke(controller, nowSeconds);
  controller.activeStroke = null;
  controller.pointerSpeed = 0;

  return {
    ended: true
  };
}

export function cancelStroke(controller, pointerState) {
  const stroke = controller.activeStroke;

  if (!stroke || (pointerState && stroke.pointerId !== pointerState.pointerId)) {
    return {
      cancelled: false,
      reason: "inactive_pointer"
    };
  }

  controller.activeStroke = null;
  controller.pointerSpeed = 0;

  return {
    cancelled: true
  };
}

export function clearPaint(controller) {
  clearScore(controller.score);
  appendDirtyRegion(
    controller.dirtyRegions,
    createFullScoreDirtyRegion(controller.score, "clear")
  );

  return controller;
}

export function getDirtyRegions(controller) {
  return controller.dirtyRegions.slice();
}

export function consumeDirtyRegions(controller) {
  const regions = getDirtyRegions(controller);

  controller.dirtyRegions.length = 0;

  return regions;
}

export function createInitialPaintState() {
  return Object.freeze({
    status: "paint_erase_clear",
    selectedColourIndex: 1,
    selectedTool: "paint",
    activePointerId: null,
    dirtyRegionCount: 0
  });
}
