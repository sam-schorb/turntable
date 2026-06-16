import { TRANSPORT_CONFIG } from "./config.js";

const DEFAULT_HAND_VELOCITY_SAMPLE_WINDOW_SECONDS = 0.12;
const DEFAULT_HAND_VELOCITY_MIN_PHASE_DELTA_TURNS = 0.000001;

function assertFiniteNumber(value, name) {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number.`);
  }
}

export function clamp(value, min, max) {
  assertFiniteNumber(value, "value");

  return Math.min(max, Math.max(min, value));
}

export function normalizePhaseTurns(phaseTurns) {
  assertFiniteNumber(phaseTurns, "phaseTurns");

  return ((phaseTurns % 1) + 1) % 1;
}

function shortestTurnDelta(fromAngleTurns, toAngleTurns) {
  assertFiniteNumber(fromAngleTurns, "fromAngleTurns");
  assertFiniteNumber(toAngleTurns, "toAngleTurns");

  return normalizePhaseTurns(toAngleTurns - fromAngleTurns + 0.5) - 0.5;
}

function resolveNowSeconds(nowSeconds) {
  if (nowSeconds === undefined) {
    return performance.now() / 1000;
  }

  assertFiniteNumber(nowSeconds, "nowSeconds");

  return nowSeconds;
}

function millisecondsToSeconds(milliseconds, name) {
  assertFiniteNumber(milliseconds, name);

  if (milliseconds < 0) {
    throw new RangeError(`${name} must be greater than or equal to 0.`);
  }

  return milliseconds / 1000;
}

function createRamp({
  fromSpeed,
  toSpeed,
  startSeconds,
  durationSeconds,
  type = "custom"
}) {
  assertFiniteNumber(fromSpeed, "fromSpeed");
  assertFiniteNumber(toSpeed, "toSpeed");
  assertFiniteNumber(startSeconds, "startSeconds");
  assertFiniteNumber(durationSeconds, "durationSeconds");

  if (durationSeconds < 0) {
    throw new RangeError("durationSeconds must be greater than or equal to 0.");
  }

  return {
    type,
    fromSpeed,
    toSpeed,
    startSeconds,
    durationSeconds,
    endSeconds: startSeconds + durationSeconds
  };
}

function rampSpeedAt(ramp, seconds) {
  if (!ramp || ramp.durationSeconds <= 0 || seconds >= ramp.endSeconds) {
    return ramp ? ramp.toSpeed : 0;
  }

  if (seconds <= ramp.startSeconds) {
    return ramp.fromSpeed;
  }

  const progress =
    (seconds - ramp.startSeconds) / Math.max(ramp.durationSeconds, 0.000001);

  return ramp.fromSpeed + (ramp.toSpeed - ramp.fromSpeed) * progress;
}

function integrateRampSpeed(ramp, startSeconds, endSeconds) {
  if (!ramp || endSeconds <= startSeconds) {
    return 0;
  }

  if (ramp.durationSeconds <= 0) {
    return ramp.toSpeed * (endSeconds - startSeconds);
  }

  let area = 0;

  if (startSeconds < ramp.startSeconds) {
    const constantEnd = Math.min(endSeconds, ramp.startSeconds);

    area += ramp.fromSpeed * (constantEnd - startSeconds);
  }

  const rampStart = Math.max(startSeconds, ramp.startSeconds);
  const rampEnd = Math.min(endSeconds, ramp.endSeconds);

  if (rampEnd > rampStart) {
    const slope = (ramp.toSpeed - ramp.fromSpeed) / ramp.durationSeconds;
    const localStart = rampStart - ramp.startSeconds;
    const localEnd = rampEnd - ramp.startSeconds;

    area +=
      ramp.fromSpeed * (localEnd - localStart) +
      0.5 * slope * (localEnd * localEnd - localStart * localStart);
  }

  if (endSeconds > ramp.endSeconds) {
    const constantStart = Math.max(startSeconds, ramp.endSeconds);

    area += ramp.toSpeed * (endSeconds - constantStart);
  }

  return area;
}

function isMotorEnabled(transport) {
  return Boolean(transport.motorEnabled);
}

function idleActualSpeed(transport) {
  return isMotorEnabled(transport) ? transport.motorTargetSpeed : 0;
}

function resolveMotionSource(transport) {
  if (transport.handGrabActive) {
    return "hand";
  }

  if (isMotorEnabled(transport) || transport.ramp) {
    return "motor";
  }

  return "idle";
}

function canStartVoices(transport) {
  return Boolean(transport.handGrabActive || isMotorEnabled(transport));
}

function createHandVelocitySample(seconds, phaseTurns) {
  return { seconds, phaseTurns };
}

function resetHandState(transport) {
  transport.handGrabActive = false;
  transport.handStartAngleTurns = null;
  transport.handPreviousAngleTurns = null;
  transport.handUnwrappedAngleTurns = null;
  transport.handPreviousUpdateSeconds = null;
  transport.handVelocitySamples = [];
  transport.handUnwrappedPhaseTurns = transport.phaseTurns;
  transport.handMotorWasEnabled = false;

  return transport;
}

function appendHandVelocitySample(transport, seconds, phaseTurns) {
  const samples = transport.handVelocitySamples;

  samples.push(createHandVelocitySample(seconds, phaseTurns));

  const cutoffSeconds = seconds - transport.handVelocitySampleWindowSeconds;

  while (samples.length > 2 && samples[1].seconds <= cutoffSeconds) {
    samples.shift();
  }
}

function resolveHandVelocity(transport) {
  const samples = transport.handVelocitySamples;

  if (samples.length < 2) {
    return 0;
  }

  const first = samples[0];
  const latest = samples[samples.length - 1];
  const elapsedSeconds = latest.seconds - first.seconds;

  if (elapsedSeconds <= 0) {
    return 0;
  }

  const phaseDeltaTurns = latest.phaseTurns - first.phaseTurns;

  if (Math.abs(phaseDeltaTurns) < transport.handVelocityMinPhaseDeltaTurns) {
    return 0;
  }

  return clamp(
    (phaseDeltaTurns * transport.baseRevolutionSeconds) / elapsedSeconds,
    transport.globalSpeedMin,
    transport.globalSpeedMax
  );
}

function syncTransportCompatibilityFields(transport) {
  transport.targetGlobalSpeed = transport.motorTargetSpeed;
  transport.isPlaying = isMotorEnabled(transport);
  transport.isPaused = !transport.isPlaying;
  transport.handGrabActive = Boolean(transport.handGrabActive);
  transport.canStartVoices = canStartVoices(transport);
  transport.motionSource = resolveMotionSource(transport);

  return transport;
}

export function createTransport(config = {}) {
  const baseRevolutionSeconds =
    config.baseRevolutionSeconds ?? TRANSPORT_CONFIG.baseRevolutionSeconds;
  const globalSpeedMin =
    config.globalSpeedMin ?? TRANSPORT_CONFIG.globalSpeedMin;
  const globalSpeedMax =
    config.globalSpeedMax ?? TRANSPORT_CONFIG.globalSpeedMax;
  const defaultTargetGlobalSpeed =
    config.defaultTargetGlobalSpeed ??
    TRANSPORT_CONFIG.defaultTargetGlobalSpeed;
  const defaultPhaseTurns =
    config.defaultPhaseTurns ?? TRANSPORT_CONFIG.defaultPhaseTurns;
  const defaultIsPlaying =
    config.defaultIsPlaying ?? TRANSPORT_CONFIG.defaultIsPlaying;
  const pauseDecelerationSeconds = millisecondsToSeconds(
    config.pauseDecelerationMs ?? TRANSPORT_CONFIG.pauseDecelerationMs,
    "pauseDecelerationMs"
  );
  const resumeAccelerationSeconds = millisecondsToSeconds(
    config.resumeAccelerationMs ?? TRANSPORT_CONFIG.resumeAccelerationMs,
    "resumeAccelerationMs"
  );

  assertFiniteNumber(baseRevolutionSeconds, "baseRevolutionSeconds");

  if (baseRevolutionSeconds <= 0) {
    throw new RangeError("baseRevolutionSeconds must be greater than 0.");
  }

  if (globalSpeedMin >= globalSpeedMax) {
    throw new RangeError("globalSpeedMin must be less than globalSpeedMax.");
  }

  const motorTargetSpeed = clamp(
    defaultTargetGlobalSpeed,
    globalSpeedMin,
    globalSpeedMax
  );
  const transport = {
    targetGlobalSpeed: motorTargetSpeed,
    motorTargetSpeed,
    motorEnabled: Boolean(defaultIsPlaying),
    handGrabActive: false,
    canStartVoices: Boolean(defaultIsPlaying),
    motionSource: Boolean(defaultIsPlaying) ? "motor" : "idle",
    actualGlobalSpeed: 0,
    phaseTurns: normalizePhaseTurns(defaultPhaseTurns),
    isPlaying: Boolean(defaultIsPlaying),
    isPaused: !Boolean(defaultIsPlaying),
    isRamping: false,
    ramp: null,
    pauseDecelerationSeconds,
    resumeAccelerationSeconds,
    nearZeroSpeedThreshold:
      config.nearZeroSpeedThreshold ?? TRANSPORT_CONFIG.nearZeroSpeedThreshold,
    handVelocitySampleWindowSeconds:
      config.handVelocitySampleWindowSeconds ??
      DEFAULT_HAND_VELOCITY_SAMPLE_WINDOW_SECONDS,
    handVelocityMinPhaseDeltaTurns:
      config.handVelocityMinPhaseDeltaTurns ??
      DEFAULT_HAND_VELOCITY_MIN_PHASE_DELTA_TURNS,
    baseRevolutionSeconds,
    globalSpeedMin,
    globalSpeedMax,
    lastUpdateSeconds: null,
    audioTime: null,
    handStartAngleTurns: null,
    handPreviousAngleTurns: null,
    handUnwrappedAngleTurns: null,
    handPreviousUpdateSeconds: null,
    handVelocitySamples: [],
    handUnwrappedPhaseTurns: normalizePhaseTurns(defaultPhaseTurns),
    handMotorWasEnabled: false
  };

  transport.actualGlobalSpeed = idleActualSpeed(transport);

  return syncTransportCompatibilityFields(transport);
}

export function scheduleTransportRamp(transport, ramp) {
  const scheduledRamp = createRamp({
    ...ramp,
    fromSpeed: clamp(
      ramp.fromSpeed,
      transport.globalSpeedMin,
      transport.globalSpeedMax
    ),
    toSpeed: clamp(ramp.toSpeed, transport.globalSpeedMin, transport.globalSpeedMax)
  });

  if (scheduledRamp.durationSeconds === 0) {
    transport.actualGlobalSpeed = scheduledRamp.toSpeed;
    transport.ramp = null;
    transport.isRamping = false;
    return syncTransportCompatibilityFields(transport);
  }

  transport.actualGlobalSpeed = scheduledRamp.fromSpeed;
  transport.ramp = scheduledRamp;
  transport.isRamping = true;

  return syncTransportCompatibilityFields(transport);
}

export function setTargetGlobalSpeed(transport, speed, nowSeconds) {
  if (nowSeconds !== undefined) {
    updateTransport(transport, nowSeconds);
  }

  assertFiniteNumber(speed, "speed");

  transport.motorTargetSpeed = clamp(
    speed,
    transport.globalSpeedMin,
    transport.globalSpeedMax
  );
  transport.targetGlobalSpeed = transport.motorTargetSpeed;

  if (transport.handGrabActive) {
    transport.ramp = null;
    transport.isRamping = false;
  } else if (transport.ramp && isMotorEnabled(transport)) {
    const currentSeconds =
      transport.lastUpdateSeconds ?? transport.ramp.startSeconds;
    const remainingSeconds = Math.max(
      0,
      transport.ramp.endSeconds - currentSeconds
    );

    scheduleTransportRamp(transport, {
      type: transport.ramp.type,
      fromSpeed: transport.actualGlobalSpeed,
      toSpeed: transport.motorTargetSpeed,
      startSeconds: currentSeconds,
      durationSeconds: remainingSeconds
    });
  } else if (isMotorEnabled(transport)) {
    transport.actualGlobalSpeed = transport.motorTargetSpeed;
  } else if (!transport.ramp && !transport.handGrabActive) {
    transport.actualGlobalSpeed = 0;
  }

  return syncTransportCompatibilityFields(transport);
}

export function requestPause(transport, nowSeconds) {
  const resolvedNowSeconds = resolveNowSeconds(nowSeconds);

  updateTransport(transport, resolvedNowSeconds);
  transport.motorEnabled = false;

  if (transport.handGrabActive) {
    transport.ramp = null;
    transport.isRamping = false;
    transport.lastUpdateSeconds = resolvedNowSeconds;
    return syncTransportCompatibilityFields(transport);
  }

  if (Math.abs(transport.actualGlobalSpeed) <= 0.000001) {
    transport.actualGlobalSpeed = 0;
    transport.ramp = null;
    transport.isRamping = false;
    transport.lastUpdateSeconds = resolvedNowSeconds;
    return syncTransportCompatibilityFields(transport);
  }

  scheduleTransportRamp(transport, {
    type: "pause",
    fromSpeed: transport.actualGlobalSpeed,
    toSpeed: 0,
    startSeconds: resolvedNowSeconds,
    durationSeconds: transport.pauseDecelerationSeconds
  });
  transport.lastUpdateSeconds = resolvedNowSeconds;

  return syncTransportCompatibilityFields(transport);
}

export function requestStop(transport, nowSeconds) {
  return requestPause(transport, nowSeconds);
}

export function requestResume(transport, nowSeconds) {
  const resolvedNowSeconds = resolveNowSeconds(nowSeconds);

  updateTransport(transport, resolvedNowSeconds);
  transport.motorEnabled = true;

  if (transport.handGrabActive) {
    transport.ramp = null;
    transport.isRamping = false;
    transport.lastUpdateSeconds = resolvedNowSeconds;
    return syncTransportCompatibilityFields(transport);
  }

  if (
    Math.abs(transport.actualGlobalSpeed - transport.motorTargetSpeed) <=
    0.000001
  ) {
    transport.actualGlobalSpeed = transport.motorTargetSpeed;
    transport.ramp = null;
    transport.isRamping = false;
    transport.lastUpdateSeconds = resolvedNowSeconds;
    return syncTransportCompatibilityFields(transport);
  }

  scheduleTransportRamp(transport, {
    type: "resume",
    fromSpeed: transport.actualGlobalSpeed,
    toSpeed: transport.motorTargetSpeed,
    startSeconds: resolvedNowSeconds,
    durationSeconds: transport.resumeAccelerationSeconds
  });
  transport.lastUpdateSeconds = resolvedNowSeconds;

  return syncTransportCompatibilityFields(transport);
}

export function setPlaying(transport, isPlaying, nowSeconds) {
  if (isPlaying) {
    return requestResume(transport, nowSeconds);
  }

  return requestPause(transport, nowSeconds);
}

export function updateTransport(transport, nowSeconds) {
  const resolvedNowSeconds = resolveNowSeconds(nowSeconds);

  if (transport.handGrabActive) {
    transport.phaseTurns = normalizePhaseTurns(transport.phaseTurns);
    transport.handUnwrappedPhaseTurns = Number.isFinite(
      transport.handUnwrappedPhaseTurns
    )
      ? transport.handUnwrappedPhaseTurns
      : transport.phaseTurns;
    transport.ramp = null;
    transport.isRamping = false;
    transport.lastUpdateSeconds = resolvedNowSeconds;

    return syncTransportCompatibilityFields(transport);
  }

  if (transport.lastUpdateSeconds === null) {
    transport.lastUpdateSeconds = resolvedNowSeconds;
    if (transport.ramp) {
      transport.actualGlobalSpeed = rampSpeedAt(transport.ramp, resolvedNowSeconds);
    } else {
      transport.actualGlobalSpeed = idleActualSpeed(transport);
    }
    return syncTransportCompatibilityFields(transport);
  }

  const elapsedSeconds = Math.max(
    0,
    resolvedNowSeconds - transport.lastUpdateSeconds
  );

  if (elapsedSeconds > 0) {
    const speedSeconds = transport.ramp
      ? integrateRampSpeed(
          transport.ramp,
          transport.lastUpdateSeconds,
          resolvedNowSeconds
        )
      : transport.actualGlobalSpeed * elapsedSeconds;
    const phaseDeltaTurns = speedSeconds / transport.baseRevolutionSeconds;

    transport.phaseTurns = normalizePhaseTurns(
      transport.phaseTurns + phaseDeltaTurns
    );
  } else {
    transport.phaseTurns = normalizePhaseTurns(transport.phaseTurns);
  }

  if (transport.ramp) {
    transport.actualGlobalSpeed = rampSpeedAt(transport.ramp, resolvedNowSeconds);

    if (resolvedNowSeconds >= transport.ramp.endSeconds) {
      transport.actualGlobalSpeed = transport.ramp.toSpeed;
      transport.ramp = null;
      transport.isRamping = false;
    } else {
      transport.isRamping = true;
    }
  } else {
    transport.actualGlobalSpeed = idleActualSpeed(transport);
    transport.isRamping = false;
  }

  if (!isMotorEnabled(transport) && !transport.ramp) {
    transport.actualGlobalSpeed = 0;
  }

  transport.lastUpdateSeconds = resolvedNowSeconds;

  return syncTransportCompatibilityFields(transport);
}

export function beginPlatterGrab(transport, angleTurns, nowSeconds) {
  const resolvedNowSeconds = resolveNowSeconds(nowSeconds);
  const normalizedAngleTurns = normalizePhaseTurns(angleTurns);

  updateTransport(transport, resolvedNowSeconds);

  transport.handGrabActive = true;
  transport.handStartAngleTurns = normalizedAngleTurns;
  transport.handPreviousAngleTurns = normalizedAngleTurns;
  transport.handUnwrappedAngleTurns = normalizedAngleTurns;
  transport.handPreviousUpdateSeconds = resolvedNowSeconds;
  transport.handUnwrappedPhaseTurns = transport.phaseTurns;
  transport.handMotorWasEnabled = isMotorEnabled(transport);
  transport.handVelocitySamples = [
    createHandVelocitySample(resolvedNowSeconds, transport.handUnwrappedPhaseTurns)
  ];
  transport.actualGlobalSpeed = 0;
  transport.ramp = null;
  transport.isRamping = false;
  transport.lastUpdateSeconds = resolvedNowSeconds;

  return syncTransportCompatibilityFields(transport);
}

export function updatePlatterGrab(transport, angleTurns, nowSeconds) {
  const resolvedNowSeconds = resolveNowSeconds(nowSeconds);
  const normalizedAngleTurns = normalizePhaseTurns(angleTurns);

  if (!transport.handGrabActive) {
    updateTransport(transport, resolvedNowSeconds);
    return syncTransportCompatibilityFields(transport);
  }

  updateTransport(transport, resolvedNowSeconds);

  const previousAngleTurns =
    transport.handPreviousAngleTurns ?? normalizedAngleTurns;
  const pointerDeltaTurns = shortestTurnDelta(
    previousAngleTurns,
    normalizedAngleTurns
  );
  const phaseDeltaTurns = -pointerDeltaTurns;

  transport.handUnwrappedAngleTurns =
    (Number.isFinite(transport.handUnwrappedAngleTurns)
      ? transport.handUnwrappedAngleTurns
      : previousAngleTurns) + pointerDeltaTurns;
  transport.handUnwrappedPhaseTurns =
    (Number.isFinite(transport.handUnwrappedPhaseTurns)
      ? transport.handUnwrappedPhaseTurns
      : transport.phaseTurns) + phaseDeltaTurns;
  transport.phaseTurns = normalizePhaseTurns(transport.handUnwrappedPhaseTurns);
  transport.handPreviousAngleTurns = normalizedAngleTurns;
  transport.handPreviousUpdateSeconds = resolvedNowSeconds;
  appendHandVelocitySample(
    transport,
    resolvedNowSeconds,
    transport.handUnwrappedPhaseTurns
  );
  transport.actualGlobalSpeed = resolveHandVelocity(transport);
  transport.ramp = null;
  transport.isRamping = false;
  transport.lastUpdateSeconds = resolvedNowSeconds;

  return syncTransportCompatibilityFields(transport);
}

export function endPlatterGrab(transport, nowSeconds) {
  const resolvedNowSeconds = resolveNowSeconds(nowSeconds);

  if (!transport.handGrabActive) {
    updateTransport(transport, resolvedNowSeconds);
    return syncTransportCompatibilityFields(transport);
  }

  updateTransport(transport, resolvedNowSeconds);
  resetHandState(transport);
  transport.ramp = null;
  transport.isRamping = false;
  transport.lastUpdateSeconds = resolvedNowSeconds;

  if (isMotorEnabled(transport)) {
    transport.actualGlobalSpeed = transport.motorTargetSpeed;
  } else {
    transport.actualGlobalSpeed = 0;
  }

  return syncTransportCompatibilityFields(transport);
}

export function cancelPlatterGrab(transport, nowSeconds) {
  return endPlatterGrab(transport, nowSeconds);
}

export function getTransportSnapshot(transport, nowSeconds) {
  updateTransport(transport, nowSeconds);

  return Object.freeze({
    targetGlobalSpeed: transport.targetGlobalSpeed,
    motorTargetSpeed: transport.motorTargetSpeed,
    motorEnabled: transport.motorEnabled,
    handGrabActive: transport.handGrabActive,
    canStartVoices: transport.canStartVoices,
    motionSource: transport.motionSource,
    actualGlobalSpeed: transport.actualGlobalSpeed,
    phaseTurns: transport.phaseTurns,
    isPlaying: transport.isPlaying,
    isPaused: transport.isPaused,
    isRamping: transport.isRamping,
    rampType: transport.ramp ? transport.ramp.type : null,
    baseRevolutionSeconds: transport.baseRevolutionSeconds,
    audioTime: transport.audioTime,
    nearZeroSpeedThreshold: transport.nearZeroSpeedThreshold
  });
}

export function createInitialTransportState() {
  const transport = createTransport();

  return Object.freeze({
    status: "ramped_audio_clock_transport",
    isPlaying: transport.isPlaying,
    isPaused: transport.isPaused,
    isRamping: transport.isRamping,
    targetGlobalSpeed: transport.targetGlobalSpeed,
    motorTargetSpeed: transport.motorTargetSpeed,
    motorEnabled: transport.motorEnabled,
    handGrabActive: transport.handGrabActive,
    canStartVoices: transport.canStartVoices,
    motionSource: transport.motionSource,
    actualGlobalSpeed: transport.actualGlobalSpeed,
    phaseTurns: transport.phaseTurns,
    baseRevolutionSeconds: transport.baseRevolutionSeconds,
    pauseDecelerationSeconds: transport.pauseDecelerationSeconds,
    resumeAccelerationSeconds: transport.resumeAccelerationSeconds,
    audioTime: transport.audioTime
  });
}
