import {
  cancelStroke,
  endStroke,
  updateStroke
} from "./paint.js";

const DEFAULT_MAX_OPERATIONS_PER_FRAME = 96;
const EVENT_TIME_SKEW_TOLERANCE_SECONDS = 60;

function resolveFallbackNowSeconds(fallbackNowSeconds) {
  return Number.isFinite(fallbackNowSeconds)
    ? fallbackNowSeconds
    : performance.now() / 1000;
}

function eventTimeToSeconds(event, fallbackNowSeconds) {
  const fallback = resolveFallbackNowSeconds(fallbackNowSeconds);
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

function pointerSampleFromEvent(event, canvas, fallbackNowSeconds, sourceEvent = event) {
  return {
    pointerId: event.pointerId,
    clientX: sourceEvent.clientX,
    clientY: sourceEvent.clientY,
    canvas,
    timeSeconds: eventTimeToSeconds(sourceEvent, fallbackNowSeconds)
  };
}
function compactProcessedQueue(queue) {
  if (queue.readIndex === 0) {
    return;
  }

  if (queue.readIndex >= queue.entries.length) {
    queue.entries.length = 0;
    queue.readIndex = 0;
    return;
  }

  if (queue.readIndex >= 64) {
    queue.entries = queue.entries.slice(queue.readIndex);
    queue.readIndex = 0;
  }
}

function queueEntryCount(queue) {
  return queue.entries.length - queue.readIndex;
}

function clearPointerEntries(queue, pointerId) {
  if (queue.entries.length === 0) {
    return;
  }

  const activeEntries = queue.entries.slice(queue.readIndex);

  queue.entries = activeEntries.filter(
    (entry) => entry.sample && entry.sample.pointerId !== pointerId
  );
  queue.readIndex = 0;
}

function sampleTimeForController(controller, sample, fallbackNowSeconds) {
  const fallback = resolveFallbackNowSeconds(fallbackNowSeconds);
  const sampleTime = Number.isFinite(sample.timeSeconds)
    ? sample.timeSeconds
    : fallback;
  const lastTransportUpdate =
    controller &&
    controller.transport &&
    Number.isFinite(controller.transport.lastUpdateSeconds)
      ? controller.transport.lastUpdateSeconds
      : null;

  return Number.isFinite(lastTransportUpdate)
    ? Math.max(sampleTime, lastTransportUpdate)
    : sampleTime;
}

function processMove(controller, sample, fallbackNowSeconds) {
  return updateStroke(
    controller,
    {
      pointerId: sample.pointerId,
      clientX: sample.clientX,
      clientY: sample.clientY,
      canvas: sample.canvas
    },
    sampleTimeForController(controller, sample, fallbackNowSeconds)
  );
}

function processEnd(controller, sample, fallbackNowSeconds) {
  const moveResult = processMove(controller, sample, fallbackNowSeconds);
  const endResult = endStroke(
    controller,
    { pointerId: sample.pointerId },
    sampleTimeForController(controller, sample, fallbackNowSeconds)
  );

  return {
    updated: moveResult.updated === true,
    ended: endResult.ended === true,
    mutationCount:
      (Number.isFinite(moveResult.mutationCount)
        ? moveResult.mutationCount
        : 0) +
      (Number.isFinite(endResult.mutationCount) ? endResult.mutationCount : 0)
  };
}

function processCancel(controller, sample) {
  return cancelStroke(controller, { pointerId: sample.pointerId });
}

export function createPointerEditQueue({
  maxOperationsPerFrame = DEFAULT_MAX_OPERATIONS_PER_FRAME
} = {}) {
  return {
    entries: [],
    readIndex: 0,
    maxOperationsPerFrame,
    stats: {
      enqueued: 0,
      processed: 0,
      droppedForCancel: 0
    }
  };
}

export function getPointerEventSamples(event, canvas, fallbackNowSeconds) {
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

export function enqueuePointerMove(queue, samples) {
  for (const sample of samples) {
    queue.entries.push({
      type: "move",
      sample
    });
    queue.stats.enqueued += 1;
  }

  return queueEntryCount(queue);
}

export function enqueuePointerEnd(queue, samples) {
  if (!Array.isArray(samples) || samples.length === 0) {
    return queueEntryCount(queue);
  }

  const moveSamples = samples.slice(0, -1);
  const finalSample = samples.at(-1);

  enqueuePointerMove(queue, moveSamples);
  queue.entries.push({
    type: "end",
    sample: finalSample
  });
  queue.stats.enqueued += 1;

  return queueEntryCount(queue);
}

export function enqueuePointerCancel(queue, sample) {
  const beforeCount = queueEntryCount(queue);

  clearPointerEntries(queue, sample.pointerId);
  queue.stats.droppedForCancel += Math.max(0, beforeCount - queueEntryCount(queue));
  queue.entries.push({
    type: "cancel",
    sample
  });
  queue.stats.enqueued += 1;

  return queueEntryCount(queue);
}

export function clearPointerEditQueue(queue, pointerId) {
  clearPointerEntries(queue, pointerId);
  return queueEntryCount(queue);
}

export function processPointerEditQueue(
  queue,
  controller,
  fallbackNowSeconds,
  { maxOperations = queue.maxOperationsPerFrame } = {}
) {
  const operationLimit =
    maxOperations === Infinity
      ? Infinity
      : Math.max(0, Math.floor(maxOperations));
  let processed = 0;
  let mutationCount = 0;
  let updated = 0;
  let ended = 0;
  let cancelled = 0;

  while (
    queue.readIndex < queue.entries.length &&
    processed < operationLimit
  ) {
    const entry = queue.entries[queue.readIndex];
    let result = null;

    queue.readIndex += 1;
    processed += 1;

    if (entry.type === "move") {
      result = processMove(controller, entry.sample, fallbackNowSeconds);
      if (result.updated) {
        updated += 1;
      }
    } else if (entry.type === "end") {
      result = processEnd(controller, entry.sample, fallbackNowSeconds);
      if (result.ended) {
        ended += 1;
      }
    } else if (entry.type === "cancel") {
      result = processCancel(controller, entry.sample);
      if (result.cancelled) {
        cancelled += 1;
      }
    }

    if (result && Number.isFinite(result.mutationCount)) {
      mutationCount += result.mutationCount;
    }
  }

  queue.stats.processed += processed;
  compactProcessedQueue(queue);

  return {
    processed,
    updated,
    ended,
    cancelled,
    mutationCount,
    pending: queueEntryCount(queue),
    hasBacklog: queueEntryCount(queue) > 0
  };
}
