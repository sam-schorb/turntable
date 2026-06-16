import {
  clientPointToDiscPoint,
  normalizeTurns,
  TAU
} from "./geometry.js";
import {
  beginPlatterGrab,
  cancelPlatterGrab,
  endPlatterGrab,
  updatePlatterGrab
} from "./transport.js";

const EVENT_TIME_SKEW_TOLERANCE_SECONDS = 60;

function assertControllerOptions({ transport, canvas, getGeometry, geometry }) {
  if (!transport) {
    throw new TypeError("transport is required.");
  }

  if (!canvas) {
    throw new TypeError("canvas is required.");
  }

  if (typeof getGeometry !== "function" && !geometry) {
    throw new TypeError("getGeometry or geometry is required.");
  }
}

function nowSecondsFallback(nowSeconds) {
  return Number.isFinite(nowSeconds) ? nowSeconds : performance.now() / 1000;
}

function eventTimeToSeconds(event, fallbackNowSeconds) {
  const fallback = nowSecondsFallback(fallbackNowSeconds);
  const eventTimeSeconds =
    event && Number.isFinite(event.timeStamp) ? event.timeStamp / 1000 : null;

  if (
    !Number.isFinite(eventTimeSeconds) ||
    eventTimeSeconds < 0 ||
    eventTimeSeconds > fallback + EVENT_TIME_SKEW_TOLERANCE_SECONDS
  ) {
    return fallback;
  }

  return eventTimeSeconds;
}

function samePointerSample(first, second) {
  return (
    first &&
    second &&
    first.pointerId === second.pointerId &&
    first.clientX === second.clientX &&
    first.clientY === second.clientY &&
    Math.abs(first.timeSeconds - second.timeSeconds) < 0.000001
  );
}

function pointerSampleFromEvent(event, canvas, fallbackNowSeconds, sourceEvent) {
  return {
    pointerId: event.pointerId,
    clientX: sourceEvent.clientX,
    clientY: sourceEvent.clientY,
    canvas,
    timeSeconds: eventTimeToSeconds(sourceEvent, fallbackNowSeconds)
  };
}

function getGeometry(controller) {
  return controller.getGeometry ? controller.getGeometry() : controller.geometry;
}

function getCanvas(controller, pointerState) {
  return pointerState && pointerState.canvas
    ? pointerState.canvas
    : controller.canvas;
}

function pointerStateToPlatterPoint(controller, pointerState) {
  const geometry = getGeometry(controller);
  const canvas = getCanvas(controller, pointerState);

  if (
    !geometry ||
    !canvas ||
    !pointerState ||
    !Number.isFinite(pointerState.clientX) ||
    !Number.isFinite(pointerState.clientY)
  ) {
    return null;
  }

  const discPoint = clientPointToDiscPoint(
    canvas,
    pointerState.clientX,
    pointerState.clientY,
    geometry
  );
  const angleTurns = normalizeTurns(Math.atan2(discPoint.y, discPoint.x) / TAU);

  return {
    pointerId: pointerState.pointerId,
    clientX: pointerState.clientX,
    clientY: pointerState.clientY,
    canvas,
    discPoint,
    angleTurns,
    radius: discPoint.radius
  };
}

function createResult(controller, flags = {}) {
  return Object.freeze({
    started: false,
    updated: false,
    ended: false,
    cancelled: false,
    pointerId: controller.activeGesture
      ? controller.activeGesture.pointerId
      : null,
    phaseTurns: controller.transport.phaseTurns,
    actualGlobalSpeed: controller.transport.actualGlobalSpeed,
    handGrabActive: controller.transport.handGrabActive,
    motionSource: controller.transport.motionSource,
    ...flags
  });
}

function isInsideCentralControl(geometry, platterPoint) {
  return platterPoint.radius <= geometry.hubRadius;
}

function isInsideVisiblePlatter(geometry, platterPoint) {
  return platterPoint.radius <= geometry.outerRadius;
}

function hitTestPlatterPoint(controller, platterPoint) {
  const geometry = getGeometry(controller);

  if (!geometry || !platterPoint) {
    return {
      hittable: false,
      reason: "missing_geometry"
    };
  }

  if (!isInsideVisiblePlatter(geometry, platterPoint)) {
    return {
      hittable: false,
      reason: "outside_platter"
    };
  }

  if (isInsideCentralControl(geometry, platterPoint)) {
    return {
      hittable: false,
      reason: "central_control"
    };
  }

  return {
    hittable: true,
    reason: "platter"
  };
}

function setLastPoint(controller, platterPoint) {
  controller.lastPointerId = platterPoint.pointerId;
  controller.lastAngleTurns = platterPoint.angleTurns;
  controller.lastRadius = platterPoint.radius;
}

function updateActiveGestureFromPoint(controller, platterPoint, nowSeconds) {
  updatePlatterGrab(
    controller.transport,
    platterPoint.angleTurns,
    nowSeconds
  );
  setLastPoint(controller, platterPoint);
  controller.activeGesture.lastAngleTurns = platterPoint.angleTurns;
  controller.activeGesture.lastRadius = platterPoint.radius;
}

export function createPlatterGestureController({
  transport,
  canvas,
  getGeometry,
  geometry
} = {}) {
  assertControllerOptions({ transport, canvas, getGeometry, geometry });

  return {
    transport,
    canvas,
    getGeometry,
    geometry,
    activeGesture: null,
    lastPointerId: null,
    lastAngleTurns: null,
    lastRadius: null,
    lastReason: null
  };
}

export function getPlatterGestureEventSamples(
  event,
  canvas,
  fallbackNowSeconds
) {
  if (!event) {
    return [];
  }

  const coalescedEvents =
    event && typeof event.getCoalescedEvents === "function"
      ? event.getCoalescedEvents()
      : [];
  const sourceEvents =
    Array.isArray(coalescedEvents) && coalescedEvents.length > 0
      ? coalescedEvents
      : [event];
  const samples = sourceEvents.map((sourceEvent) =>
    pointerSampleFromEvent(event, canvas, fallbackNowSeconds, sourceEvent)
  );
  const finalSample = pointerSampleFromEvent(
    event,
    canvas,
    fallbackNowSeconds,
    event
  );

  if (!samePointerSample(samples.at(-1), finalSample)) {
    samples.push(finalSample);
  }

  return samples;
}

export function beginPlatterGesture(controller, pointerState, nowSeconds) {
  if (controller.activeGesture) {
    controller.lastReason = "gesture_already_active";
    return createResult(controller, {
      reason: controller.lastReason,
      pointerId: pointerState ? pointerState.pointerId : null
    });
  }

  const resolvedNowSeconds = nowSecondsFallback(nowSeconds);
  const platterPoint = pointerStateToPlatterPoint(controller, pointerState);
  const pointerId = pointerState ? pointerState.pointerId : null;

  if (!pointerState) {
    controller.lastReason = "missing_pointer";
    return createResult(controller, {
      reason: controller.lastReason,
      pointerId
    });
  }

  const hitTest = hitTestPlatterPoint(controller, platterPoint);

  if (!hitTest.hittable) {
    controller.lastReason = hitTest.reason;
    return createResult(controller, {
      reason: hitTest.reason,
      pointerId
    });
  }

  beginPlatterGrab(
    controller.transport,
    platterPoint.angleTurns,
    resolvedNowSeconds
  );
  setLastPoint(controller, platterPoint);
  controller.lastReason = null;
  controller.activeGesture = {
    pointerId: pointerState.pointerId,
    startedAtSeconds: resolvedNowSeconds,
    lastAngleTurns: platterPoint.angleTurns,
    lastRadius: platterPoint.radius
  };

  return createResult(controller, {
    started: true,
    pointerId: pointerState.pointerId,
    angleTurns: platterPoint.angleTurns,
    radius: platterPoint.radius
  });
}

export function updatePlatterGesture(controller, pointerState, nowSeconds) {
  const gesture = controller.activeGesture;
  const pointerId = pointerState ? pointerState.pointerId : null;

  if (!gesture || !pointerState || gesture.pointerId !== pointerId) {
    controller.lastReason = "inactive_pointer";
    return createResult(controller, {
      reason: controller.lastReason,
      pointerId
    });
  }

  const resolvedNowSeconds = nowSecondsFallback(nowSeconds);
  const platterPoint = pointerStateToPlatterPoint(controller, pointerState);

  if (!platterPoint) {
    controller.lastReason = "missing_geometry";
    return createResult(controller, {
      reason: controller.lastReason,
      pointerId
    });
  }

  if (platterPoint.radius <= 0) {
    controller.lastReason = "ambiguous_angle";
    return createResult(controller, {
      reason: controller.lastReason,
      pointerId
    });
  }

  updateActiveGestureFromPoint(controller, platterPoint, resolvedNowSeconds);
  controller.lastReason = null;

  return createResult(controller, {
    updated: true,
    pointerId,
    angleTurns: platterPoint.angleTurns,
    radius: platterPoint.radius
  });
}

export function endPlatterGesture(controller, pointerState, nowSeconds) {
  const gesture = controller.activeGesture;
  const requestedPointerId = pointerState ? pointerState.pointerId : null;

  if (!gesture || (pointerState && gesture.pointerId !== requestedPointerId)) {
    controller.lastReason = "inactive_pointer";
    return createResult(controller, {
      reason: controller.lastReason,
      pointerId: requestedPointerId
    });
  }

  const resolvedNowSeconds = nowSecondsFallback(nowSeconds);
  const platterPoint = pointerState
    ? pointerStateToPlatterPoint(controller, pointerState)
    : null;

  if (platterPoint && platterPoint.radius > 0) {
    updateActiveGestureFromPoint(controller, platterPoint, resolvedNowSeconds);
  }

  const pointerId = gesture.pointerId;

  endPlatterGrab(controller.transport, resolvedNowSeconds);
  controller.activeGesture = null;
  controller.lastReason = null;

  return createResult(controller, {
    ended: true,
    pointerId
  });
}

export function cancelPlatterGesture(controller, pointerState, nowSeconds) {
  const gesture = controller.activeGesture;
  const requestedPointerId = pointerState ? pointerState.pointerId : null;

  if (!gesture || (pointerState && gesture.pointerId !== requestedPointerId)) {
    controller.lastReason = "inactive_pointer";
    return createResult(controller, {
      reason: controller.lastReason,
      pointerId: requestedPointerId
    });
  }

  const pointerId = gesture.pointerId;

  cancelPlatterGrab(controller.transport, nowSecondsFallback(nowSeconds));
  controller.activeGesture = null;
  controller.lastReason = null;

  return createResult(controller, {
    cancelled: true,
    pointerId
  });
}

export function getPlatterGestureState(controller) {
  return Object.freeze({
    active: Boolean(controller.activeGesture),
    activePointerId: controller.activeGesture
      ? controller.activeGesture.pointerId
      : null,
    lastPointerId: controller.lastPointerId,
    lastAngleTurns: controller.lastAngleTurns,
    lastRadius: controller.lastRadius,
    lastReason: controller.lastReason,
    phaseTurns: controller.transport.phaseTurns,
    actualGlobalSpeed: controller.transport.actualGlobalSpeed,
    handGrabActive: controller.transport.handGrabActive,
    motionSource: controller.transport.motionSource
  });
}
