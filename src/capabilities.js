function getAudioContextConstructor(scope) {
  return scope.AudioContext || scope.webkitAudioContext || null;
}

function supportsCanvas2D(scope) {
  const documentRef = scope.document;

  if (!documentRef || typeof documentRef.createElement !== "function") {
    return false;
  }

  const canvas = documentRef.createElement("canvas");

  if (!canvas || typeof canvas.getContext !== "function") {
    return false;
  }

  try {
    return Boolean(canvas.getContext("2d"));
  } catch {
    return false;
  }
}

function supportsAudioWorkletWithoutStartingAudio(scope) {
  const AudioContextConstructor = getAudioContextConstructor(scope);
  const baseAudioPrototype =
    scope.BaseAudioContext && scope.BaseAudioContext.prototype;
  const audioContextPrototype =
    AudioContextConstructor && AudioContextConstructor.prototype;

  return Boolean(
    (baseAudioPrototype && "audioWorklet" in baseAudioPrototype) ||
      (audioContextPrototype && "audioWorklet" in audioContextPrototype)
  );
}

export function detectCapabilities(scope = globalThis) {
  const AudioContextConstructor = getAudioContextConstructor(scope);

  return [
    {
      id: "canvas-2d",
      label: "Canvas 2D",
      supported: supportsCanvas2D(scope),
      detail: "visual surface"
    },
    {
      id: "pointer-events",
      label: "Pointer Events",
      supported: "PointerEvent" in scope,
      detail: "drawing input"
    },
    {
      id: "audio-context",
      label: "Web Audio",
      supported: Boolean(AudioContextConstructor),
      detail: "playback engine"
    },
    {
      id: "audio-worklet",
      label: "AudioWorklet",
      supported: supportsAudioWorkletWithoutStartingAudio(scope),
      detail: "sampler core"
    },
    {
      id: "cross-origin-isolated",
      label: "Cross-origin isolation",
      supported: Boolean(scope.crossOriginIsolated),
      detail: "shared memory gate"
    },
    {
      id: "shared-array-buffer",
      label: "SharedArrayBuffer",
      supported: "SharedArrayBuffer" in scope,
      detail: "optional release path"
    }
  ];
}

export function summarizeCapabilities(capabilities) {
  const supportedCount = capabilities.filter((capability) => capability.supported)
    .length;

  return {
    supportedCount,
    totalCount: capabilities.length,
    allSupported: supportedCount === capabilities.length
  };
}
