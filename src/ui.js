import {
  getAudioEngineState,
  setLoopDefaults,
  syncAllSampleSlots,
  syncSampleSlot,
  unlockAudio,
} from './audio-engine.js';
import { SAMPLE_CONFIG, TRANSPORT_CONFIG } from './config.js';
import { clientPointToDiscPoint } from './geometry.js';
import { createLoopState, getLoopStateSnapshot } from './loop-state.js';
import {
  beginStroke,
  clearPaint,
  clearPaintToolSelection,
  consumeDirtyRegions,
  createPaintController,
  setSelectedColour,
  setTool,
  tickStroke,
} from './paint.js';
import {
  createPlayheadAnalyzer,
} from './playhead-analyzer.js';
import {
  clearPointerEditQueue,
  createPointerEditQueue,
  enqueuePointerCancel,
  enqueuePointerEnd,
  enqueuePointerMove,
  getPointerEventSamples,
  processPointerEditQueue,
} from './pointer-edit-queue.js';
import {
  createRenderer,
  renderTurntable,
  resizeRenderer,
} from './renderer.js';
import {
  getSampleSlots,
  loadDefaultSamples,
  replaceSlotSample,
} from './sample-manager.js';
import {
  createScoreSync,
  selectSyncMode,
} from './score-sync.js';
import {
  createReaderEngine,
  destroyReaderEngine,
  invalidateReader,
  runReaderEngine,
} from './reader-engine.js';
import { getVisiblePlayheadSegment } from './sensor-geometry.js';
import {
  getTransportSnapshot,
  requestPause,
  requestResume,
  setTargetGlobalSpeed,
  updateTransport,
} from './transport.js';
import {
  createVoiceManager,
  getVoiceState,
  handleSampleReplacement,
  handleScoreCleared,
  reconcileDescriptors,
} from './voice-manager.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const DISC_SURFACE = '#ffe6cc';
const DISC_BOUNDARY = '#000000';
const DISC_BOUNDARY_WIDTH = 1.5;
const CENTER_BUTTON_FILL = '#8000ff';
const PLAYHEAD_STROKE = 'rgba(0, 255, 128, 0.58)';
const PLAYHEAD_CORE = '#8000ff';
const READER_INTERVAL_MS = 8;

function createElement(tagName, options = {}) {
  const element = document.createElement(tagName);

  if (options.className) {
    element.className = options.className;
  }

  if (options.testId) {
    element.dataset.testid = options.testId;
  }

  if (options.text !== undefined) {
    element.textContent = options.text;
  }

  return element;
}

function createSvgElement(tagName, options = {}) {
  const element = document.createElementNS(SVG_NS, tagName);

  if (options.className) {
    element.setAttribute('class', options.className);
  }

  if (options.testId) {
    element.dataset.testid = options.testId;
  }

  return element;
}

function setSvgAttributes(element, attributes) {
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, String(value));
  }
}

function setSvgCircle(circle, center, radius, extraAttributes = {}) {
  setSvgAttributes(circle, {
    cx: center.x,
    cy: center.y,
    r: radius,
    ...extraAttributes,
  });
}

function createToolIcon(type) {
  const svg = createSvgElement('svg', {
    className: 'tool-button__icon',
    testId: `${type}-tool-icon`,
  });

  setSvgAttributes(svg, {
    viewBox: '0 0 24 24',
    'aria-hidden': 'true',
    focusable: 'false',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': 4,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  });

  if (type === 'eraser') {
    const outline = createSvgElement('path');
    const seam = createSvgElement('path');
    const baseline = createSvgElement('path');

    setSvgAttributes(outline, {
      d: 'm7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21',
    });
    setSvgAttributes(seam, {
      d: 'm5 11 9 9',
    });
    setSvgAttributes(baseline, {
      d: 'M22 21H7',
    });
    svg.append(outline, seam, baseline);
    return svg;
  }

  const slashA = createSvgElement('path');
  const slashB = createSvgElement('path');

  setSvgAttributes(slashA, {
    d: 'M18 6 6 18',
  });
  setSvgAttributes(slashB, {
    d: 'm6 6 12 12',
  });
  svg.append(slashA, slashB);
  return svg;
}

function createTransportIcon(type) {
  const svg = createSvgElement('svg', {
    className: `transport-button__icon transport-button__icon--${type}`,
    testId: `transport-${type}-icon`,
  });

  setSvgAttributes(svg, {
    viewBox: '0 0 24 24',
    'aria-hidden': 'true',
    focusable: 'false',
    fill: 'currentColor',
  });

  if (type === 'play') {
    const triangle = createSvgElement('path');

    setSvgAttributes(triangle, {
      d: 'M8 5v14l11-7Z',
    });
    svg.append(triangle);
    return svg;
  }

  const leftBar = createSvgElement('rect');
  const rightBar = createSvgElement('rect');

  setSvgAttributes(leftBar, {
    x: 7,
    y: 5,
    width: 3.5,
    height: 14,
    rx: 0.8,
  });
  setSvgAttributes(rightBar, {
    x: 13.5,
    y: 5,
    width: 3.5,
    height: 14,
    rx: 0.8,
  });
  svg.append(leftBar, rightBar);
  return svg;
}

function createTurntableVectorChrome() {
  const baseSvg = createSvgElement('svg', {
    className: 'turntable-vector turntable-vector--base',
    testId: 'turntable-vector-base',
  });
  const chromeSvg = createSvgElement('svg', {
    className: 'turntable-vector turntable-vector--chrome',
    testId: 'turntable-vector-chrome',
  });
  const baseDisc = createSvgElement('circle', {
    className: 'turntable-vector__disc',
  });
  const playhead = createSvgElement('line', {
    className: 'turntable-vector__playhead',
  });
  const playheadCore = createSvgElement('line', {
    className: 'turntable-vector__playhead-core',
  });
  const hub = createSvgElement('g', {
    className: 'turntable-vector__hub',
  });
  const hubBase = createSvgElement('circle', {
    className: 'turntable-vector__hub-base',
  });

  for (const svg of [baseSvg, chromeSvg]) {
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  }

  setSvgAttributes(baseDisc, {
    fill: DISC_SURFACE,
    stroke: DISC_BOUNDARY,
    'stroke-width': DISC_BOUNDARY_WIDTH,
  });
  setSvgAttributes(playhead, {
    stroke: PLAYHEAD_STROKE,
    'stroke-linecap': 'round',
  });
  setSvgAttributes(playheadCore, {
    stroke: PLAYHEAD_CORE,
    'stroke-linecap': 'round',
  });
  setSvgAttributes(hubBase, {
    fill: CENTER_BUTTON_FILL,
    stroke: DISC_BOUNDARY,
    'stroke-width': DISC_BOUNDARY_WIDTH,
  });
  hub.append(hubBase);
  baseSvg.append(baseDisc);
  chromeSvg.append(playheadCore, playhead, hub);

  return {
    baseSvg,
    chromeSvg,
    baseDisc,
    playhead,
    playheadCore,
    hub,
    hubBase,
  };
}

function updateSvgViewport(svg, geometry) {
  setSvgAttributes(svg, {
    viewBox: `0 0 ${geometry.width} ${geometry.height}`,
    width: geometry.width,
    height: geometry.height,
  });
}

function updateTurntableVectorPhase(chrome, geometry, phaseTurns) {
  if (!chrome || !geometry) {
    return;
  }

  const normalizedPhaseTurns = ((phaseTurns % 1) + 1) % 1;
  const rotationDegrees = -normalizedPhaseTurns * 360;

  setSvgAttributes(chrome.hub, {
    transform: `rotate(${rotationDegrees.toFixed(3)} ${geometry.center.x.toFixed(
      3
    )} ${geometry.center.y.toFixed(3)})`,
    'data-phase-turns': normalizedPhaseTurns.toFixed(6),
  });
}

function updateTurntableVectorChrome(chrome, geometry) {
  if (!chrome || !geometry) {
    return;
  }

  updateSvgViewport(chrome.baseSvg, geometry);
  updateSvgViewport(chrome.chromeSvg, geometry);
  setSvgCircle(chrome.baseDisc, geometry.center, geometry.outerRadius);

  const segment = getVisiblePlayheadSegment(geometry);
  const coreStart = {
    x: segment.start.x - segment.direction.x * segment.coreInsetPx,
    y: segment.start.y - segment.direction.y * segment.coreInsetPx,
  };
  const coreEnd = {
    x: segment.end.x + segment.direction.x * segment.coreInsetPx,
    y: segment.end.y + segment.direction.y * segment.coreInsetPx,
  };

  setSvgAttributes(chrome.playhead, {
    x1: segment.start.x,
    y1: segment.start.y,
    x2: segment.end.x,
    y2: segment.end.y,
    'stroke-width': segment.width,
  });
  setSvgAttributes(chrome.playheadCore, {
    x1: coreStart.x,
    y1: coreStart.y,
    x2: coreEnd.x,
    y2: coreEnd.y,
    'stroke-width': segment.coreWidth,
  });
  setSvgCircle(chrome.hubBase, geometry.center, geometry.innerPlayableRadius);
  setSvgAttributes(chrome.hubBase, {
    stroke: DISC_BOUNDARY,
    'stroke-width': DISC_BOUNDARY_WIDTH,
  });
  chrome.hub.removeAttribute('stroke');
  chrome.hub.removeAttribute('fill');
}

function nowSeconds() {
  return performance.now() / 1000;
}

function createCenterTransportButton() {
  const playButton = createElement('button', {
    className: 'transport-button turntable-play-button',
    testId: 'transport-play',
  });
  const iconShell = createElement('span', {
    className: 'turntable-play-button__icon-shell',
    testId: 'transport-play-icon-shell',
  });

  playButton.type = 'button';
  playButton.setAttribute('aria-label', 'Play');
  playButton.setAttribute('aria-pressed', 'false');
  iconShell.append(createTransportIcon('play'), createTransportIcon('pause'));
  playButton.append(iconShell);

  return {
    element: playButton,
    playButton,
    update(snapshot) {
      playButton.setAttribute(
        'aria-label',
        snapshot.isPlaying ? 'Pause' : 'Play'
      );
      playButton.setAttribute(
        'aria-pressed',
        snapshot.isPlaying ? 'true' : 'false'
      );
    },
    updateGeometry(geometry) {
      if (!geometry) {
        return;
      }

      const diameter = geometry.innerPlayableRadius * 2;
      playButton.style.left = `${geometry.center.x}px`;
      playButton.style.top = `${geometry.center.y}px`;
      playButton.style.width = `${diameter}px`;
      playButton.style.height = `${diameter}px`;
    },
    updatePhase(phaseTurns) {
      const normalizedPhaseTurns = ((phaseTurns % 1) + 1) % 1;
      const rotationDegrees = -normalizedPhaseTurns * 360;

      iconShell.style.transform = `rotate(${rotationDegrees.toFixed(3)}deg)`;
      playButton.dataset.phaseTurns = normalizedPhaseTurns.toFixed(6);
      playButton.dataset.rotationDegrees = rotationDegrees.toFixed(3);
    },
  };
}

function updateSpeedSliderFill(slider) {
  const min = Number(slider.min);
  const max = Number(slider.max);
  const value = Number(slider.value);
  const range = max - min;
  const rawPercent = range === 0 ? 0 : ((value - min) / range) * 100;
  const fillPercent = Math.min(100, Math.max(0, rawPercent));

  slider.style.setProperty('--speed-fill-percent', `${fillPercent.toFixed(2)}%`);
  slider.parentElement?.style.setProperty(
    '--speed-fill-percent',
    `${fillPercent.toFixed(2)}%`
  );
}

function createTransportControls(transport) {
  const controls = createElement('div', {
    className: 'transport-controls',
    testId: 'transport-controls',
  });
  const sliderGroup = createElement('label', {
    className: 'speed-control',
  });
  const sliderHeader = createElement('span', {
    className: 'speed-control__header',
    text: 'Speed',
  });
  const slider = createElement('input', {
    className: 'speed-control__slider',
    testId: 'speed-slider',
  });
  const sliderFrame = createElement('span', {
    className: 'speed-control__slider-frame',
    testId: 'speed-slider-frame',
  });
  const sliderTrack = createElement('span', {
    className: 'speed-control__track',
    testId: 'speed-track',
  });
  const sliderThumb = createElement('span', {
    className: 'speed-control__thumb',
    testId: 'speed-thumb',
  });
  const tickList = createElement('div', {
    className: 'speed-control__ticks',
    testId: 'speed-ticks',
  });

  slider.type = 'range';
  slider.min = String(TRANSPORT_CONFIG.globalSpeedMin);
  slider.max = String(TRANSPORT_CONFIG.globalSpeedMax);
  slider.step = '0.01';
  slider.value = String(transport.targetGlobalSpeed);
  slider.setAttribute('aria-label', 'Signed global speed');
  updateSpeedSliderFill(slider);

  for (const tick of [+4, +2, +1, 0, -1, -2, -4]) {
    tickList.append(
      createElement('span', {
        className:
          tick === 0 ? 'speed-control__tick is-zero' : 'speed-control__tick',
        text: tick > 0 ? `+${tick}` : String(tick),
      })
    );
  }

  sliderFrame.append(sliderTrack, sliderThumb, slider);
  sliderGroup.append(sliderHeader, sliderFrame, tickList);
  controls.append(sliderGroup);

  return {
    element: controls,
    slider,
  };
}

function summarizeVoicesBySlot(voiceState) {
  const bySlot = new Map();
  const voices =
    voiceState && Array.isArray(voiceState.voices) ? voiceState.voices : [];

  for (const voice of voices) {
    const summary = bySlot.get(voice.slotIndex) || {
      activeCount: 0,
      soundingCount: 0,
    };

    summary.activeCount += 1;

    if (
      Math.abs(voice.effectivePlaybackRate) >=
        TRANSPORT_CONFIG.nearZeroSpeedThreshold &&
      voice.amplitude > 0
    ) {
      summary.soundingCount += 1;
    }

    bySlot.set(voice.slotIndex, summary);
  }

  return bySlot;
}

function summarizeVoiceActivity(voiceState) {
  const slotActivity = Array.from({ length: 6 }, () => ({
    activeCount: 0,
    soundingCount: 0,
  }));
  const voices =
    voiceState && Array.isArray(voiceState.voices) ? voiceState.voices : [];

  for (const voice of voices) {
    const summary = slotActivity[voice.slotIndex];

    if (!summary) {
      continue;
    }

    summary.activeCount += 1;

    if (
      Math.abs(voice.effectivePlaybackRate) >=
        TRANSPORT_CONFIG.nearZeroSpeedThreshold &&
      voice.amplitude > 0
    ) {
      summary.soundingCount += 1;
    }
  }

  return slotActivity
    .map(summary => `${summary.activeCount}:${summary.soundingCount}`)
    .join(',');
}

function createPaintControlsSignature(
  controller,
  sampleManager,
  voiceState,
  loopState
) {
  const sampleSignature = getSampleSlots(sampleManager)
    .map(slot =>
      [
        slot.slotIndex,
        slot.displayName,
        slot.status,
        slot.version,
        slot.message || '',
        slot.wasTrimmed ? 'trimmed' : 'full',
        slot.slotLoopMode || 'inherit',
      ].join(':')
    )
    .join('|');

  return [
    controller.tool,
    controller.selectedColourIndex ?? 'none',
    loopState && loopState.globalLoopMode ? 'loop' : 'no-loop',
    sampleSignature,
    summarizeVoiceActivity(voiceState),
  ].join('||');
}

function createSampleControls(pointerEventsSupported, sampleManager) {
  const controls = createElement('div', {
    className: 'paint-controls',
    testId: 'paint-controls',
  });
  const swatches = createElement('div', {
    className: 'sample-slots',
    testId: 'paint-swatches',
  });
  const tools = createElement('div', {
    className: 'paint-tools',
    testId: 'paint-tools',
  });
  const eraserButton = createElement('button', {
    className: 'tool-button tool-button--eraser',
    testId: 'eraser-tool',
  });
  const clearButton = createElement('button', {
    className: 'tool-button tool-button--danger',
    testId: 'clear-paint',
  });
  const eraserLabel = createElement('span', {
    className: 'tool-button__label',
    text: 'Eraser',
  });
  const clearLabel = createElement('span', {
    className: 'tool-button__label',
    text: 'Clear',
  });
  const swatchButtons = new Map();
  const fileInputs = new Map();
  const slotViews = new Map();

  for (const slot of getSampleSlots(sampleManager)) {
    const chip = createElement('div', {
      className: 'sample-chip',
      testId: `sample-slot-${slot.slotIndex}`,
    });
    const action = createElement('div', {
      className: 'sample-chip__action',
    });
    const swatch = createElement('button', {
      className: 'sample-chip__select paint-swatch',
      testId: `paint-colour-${slot.colourIndex}`,
    });
    const sampleName = createElement('span', {
      className: 'sample-chip__name',
      testId: `sample-name-${slot.slotIndex}`,
      text: slot.displayName,
    });
    const uploadLabel = createElement('label', {
      className: 'sample-chip__upload',
      testId: `sample-upload-label-${slot.slotIndex}`,
    });
    const uploadIcon = createSvgElement('svg', {
      className: 'sample-chip__upload-icon',
    });
    const uploadMark = createSvgElement('polyline', {
      className: 'sample-chip__upload-mark',
    });
    const fileInput = createElement('input', {
      className: 'sample-chip__file-input',
      testId: `sample-upload-${slot.slotIndex}`,
    });
    const message = createElement('span', {
      className: 'sample-chip__message',
      testId: `sample-message-${slot.slotIndex}`,
    });

    swatch.type = 'button';
    swatch.style.setProperty('--swatch-colour', slot.colour);
    swatch.setAttribute(
      'aria-label',
      `Select ${slot.defaultName} paint colour`
    );
    swatch.dataset.colourIndex = String(slot.colourIndex);
    swatch.disabled = !pointerEventsSupported;
    fileInput.type = 'file';
    fileInput.accept = SAMPLE_CONFIG.acceptedFileTypes;
    fileInput.dataset.slotIndex = String(slot.slotIndex);
    uploadLabel.setAttribute(
      'aria-label',
      `Replace ${slot.defaultName} sample`
    );
    uploadLabel.setAttribute('title', `Replace ${slot.defaultName} sample`);
    setSvgAttributes(uploadIcon, {
      viewBox: '0 0 12 12',
      'aria-hidden': 'true',
      focusable: 'false',
    });
    setSvgAttributes(uploadMark, {
      points: '4 2 8 6 4 10',
    });
    uploadIcon.append(uploadMark);
    uploadLabel.append(uploadIcon, fileInput);
    swatch.append(sampleName);
    action.append(swatch, uploadLabel);
    chip.append(action, message);
    swatchButtons.set(slot.colourIndex, swatch);
    fileInputs.set(slot.slotIndex, fileInput);
    slotViews.set(slot.slotIndex, {
      chip,
      sampleName,
      message,
    });
    swatches.append(chip);
  }

  eraserButton.type = 'button';
  clearButton.type = 'button';
  eraserButton.setAttribute('aria-label', 'Eraser');
  clearButton.setAttribute('aria-label', 'Clear');
  eraserButton.append(eraserLabel, createToolIcon('eraser'));
  clearButton.append(clearLabel, createToolIcon('clear'));
  eraserButton.disabled = !pointerEventsSupported;
  clearButton.disabled = !pointerEventsSupported;
  tools.append(eraserButton, clearButton);
  swatches.append(tools);
  controls.append(swatches);

  return {
    element: controls,
    swatchButtons,
    fileInputs,
    eraserButton,
    clearButton,
    update(
      controller,
      activeSampleManager = sampleManager,
      voiceState,
      loopState
    ) {
      const voicesBySlot = summarizeVoicesBySlot(voiceState);

      controls.dataset.paintTool = controller.tool;
      controls.dataset.selectedColourIndex =
        controller.selectedColourIndex == null
          ? 'none'
          : String(controller.selectedColourIndex);
      controls.classList.toggle(
        'is-looping',
        Boolean(loopState && loopState.globalLoopMode)
      );

      for (const [colourIndex, button] of swatchButtons.entries()) {
        const selected =
          controller.tool === 'paint' &&
          controller.selectedColourIndex === colourIndex;
        const chip = button.closest('.sample-chip');

        button.classList.toggle('is-selected', selected);
        button.setAttribute('aria-pressed', selected ? 'true' : 'false');
        chip?.classList.toggle('is-selected', selected);
      }

      eraserButton.classList.toggle('is-selected', controller.tool === 'erase');
      eraserButton.setAttribute(
        'aria-pressed',
        controller.tool === 'erase' ? 'true' : 'false'
      );

      for (const slot of getSampleSlots(activeSampleManager)) {
        const view = slotViews.get(slot.slotIndex);

        if (!view) {
          continue;
        }

        view.sampleName.textContent = slot.displayName;
        const slotVoiceSummary = voicesBySlot.get(slot.slotIndex) || {
          activeCount: 0,
          soundingCount: 0,
        };
        view.message.textContent = slot.message || '';
        view.chip.classList.toggle('is-loading', slot.status === 'loading');
        view.chip.classList.toggle('is-error', slot.status === 'error');
        view.chip.classList.toggle('is-trimmed', Boolean(slot.wasTrimmed));
        view.chip.classList.toggle(
          'is-active',
          slotVoiceSummary.activeCount > 0
        );
        view.chip.classList.toggle(
          'is-sounding',
          slotVoiceSummary.soundingCount > 0
        );
      }
    },
  };
}

export function mountAppShell(root, context) {
  const { capabilities, score, transport, sampleManager, audioEngine } =
    context;
  const pointerEventsSupported = capabilities.some(
    capability => capability.id === 'pointer-events' && capability.supported
  );
  const app = createElement('div', {
    className: 'app-shell',
    testId: 'app-shell',
  });

  const main = createElement('main', { className: 'app-main' });
  const workspace = createElement('section', {
    className: 'workspace',
    testId: 'workspace',
  });
  const surface = createElement('div', {
    className: 'turntable-surface',
    testId: 'turntable-surface',
  });
  const visual = createElement('div', {
    className: 'turntable-visual',
    testId: 'turntable-visual',
  });
  const canvas = createElement('canvas', {
    className: 'turntable-canvas',
    testId: 'turntable-canvas',
  });
  canvas.dataset.pointerCaptureRequested = 'false';
  canvas.dataset.pointerCaptureActive = 'false';
  const vectorChrome = createTurntableVectorChrome();
  const loopState = createLoopState({
    slotLoopModes: getSampleSlots(sampleManager).map(slot => slot.slotLoopMode),
  });
  const paintControls = createSampleControls(
    pointerEventsSupported,
    sampleManager
  );
  const transportControls = createTransportControls(transport);
  const centerTransportButton = createCenterTransportButton();

  visual.append(
    vectorChrome.baseSvg,
    canvas,
    vectorChrome.chromeSvg,
    centerTransportButton.element
  );
  surface.append(visual);
  workspace.append(paintControls.element, surface, transportControls.element);

  main.append(workspace);
  app.append(main);
  root.replaceChildren(app);

  const renderer = createRenderer(canvas);
  const playheadAnalyzer = createPlayheadAnalyzer({
    score,
    getGeometry: () => renderer.geometry,
  });
  const scoreSync = createScoreSync({
    score,
    analyzer: playheadAnalyzer,
    audioEngine,
    scope: window,
  });
  selectSyncMode(scoreSync, capabilities);
  const voiceManager = createVoiceManager({
    audioEngine,
    sampleManager,
  });
  const paintController = createPaintController({
    score,
    transport,
    canvas,
    getGeometry: () => renderer.geometry,
  });
  const readerEngine = createReaderEngine({
    analyzer: playheadAnalyzer,
    scoreSync,
    audioEngine,
    voiceManager,
    getGeometry: () => renderer.geometry,
    scope: window,
    onVoiceStateChange: (voiceState) => {
      updatePaintControlsIfNeeded(false, voiceState);
    },
  });
  const pointerEditQueue = createPointerEditQueue();
  let animationFrameId = null;
  let readerIntervalId = null;
  let audioUnlockPromise = null;
  let lastRenderedKey = null;
  let lastPaintControlsSignature = null;
  let lastTransportControlsSignature = null;

  function updateTransportDataset(snapshot) {
    canvas.dataset.transportPhase = snapshot.phaseTurns.toFixed(6);
    canvas.dataset.transportPlaying = snapshot.isPlaying ? 'true' : 'false';
    centerTransportButton.updatePhase(snapshot.phaseTurns);
  }

  function updateTransportControlsIfNeeded(snapshot, force = false) {
    const signature = [
      snapshot.isPlaying ? 'playing' : 'stopped',
      snapshot.isPaused ? 'paused' : 'unpaused',
      snapshot.isRamping ? 'ramping' : 'steady',
    ].join(':');

    if (force || signature !== lastTransportControlsSignature) {
      centerTransportButton.update(snapshot);
      lastTransportControlsSignature = signature;
    }
  }

  function updatePaintControlsIfNeeded(
    force = false,
    voiceState = getVoiceState(voiceManager)
  ) {
    const signature = createPaintControlsSignature(
      paintController,
      sampleManager,
      voiceState,
      loopState
    );

    if (force || signature !== lastPaintControlsSignature) {
      paintControls.update(
        paintController,
        sampleManager,
        voiceState,
        loopState
      );
      lastPaintControlsSignature = signature;
    }
  }

  function clearPaintSelectionFromBackground(event) {
    if (event.button !== undefined && event.button !== 0) {
      return;
    }

    const target =
      event.target instanceof Element ? event.target : event.currentTarget;

    if (!target || target.closest('[data-testid="transport-play"]')) {
      return;
    }

    if (
      target.closest(
        '[data-testid="paint-controls"], [data-testid="transport-controls"]'
      )
    ) {
      return;
    }

    const turntableVisual = target.closest('[data-testid="turntable-visual"]');

    if (turntableVisual) {
      if (!renderer.geometry) {
        return;
      }

      const discPoint = clientPointToDiscPoint(
        canvas,
        event.clientX,
        event.clientY,
        renderer.geometry
      );

      if (discPoint.radius <= renderer.geometry.outerRadius) {
        return;
      }
    }

    if (
      paintController.tool === 'none' &&
      paintController.selectedColourIndex == null
    ) {
      return;
    }

    clearPaintToolSelection(paintController);
    updatePaintControlsIfNeeded(true);
  }

  function createRenderedKey(snapshot) {
    const geometry = renderer.geometry;

    return [
      score.version,
      snapshot.phaseTurns.toFixed(6),
      geometry ? geometry.width.toFixed(2) : '0',
      geometry ? geometry.height.toFixed(2) : '0',
      renderer.devicePixelRatio,
    ].join(':');
  }

  function shouldRenderVisualFrame(snapshot, dirtyRegions) {
    if (
      dirtyRegions.length > 0 ||
      paintController.activeStroke ||
      snapshot.isPlaying ||
      snapshot.isRamping
    ) {
      return true;
    }

    return createRenderedKey(snapshot) !== lastRenderedKey;
  }

  function createFrameState(frameNow) {
    return {
      nowSeconds: frameNow,
      pointerInput: null,
      snapshot: null,
      dirtyRegions: [],
      audioState: null,
      descriptorPayload: null,
      voiceState: null,
    };
  }

  function flushQueuedPointerEdits(frameNow, options = {}) {
    return processPointerEditQueue(pointerEditQueue, paintController, frameNow, {
      maxOperations:
        options.maxOperations === undefined
          ? pointerEditQueue.maxOperationsPerFrame
          : options.maxOperations,
    });
  }

  function processPendingEdits(frame) {
    frame.pointerInput = flushQueuedPointerEdits(frame.nowSeconds);

    if (paintController.activeStroke && !frame.pointerInput.hasBacklog) {
      tickStroke(paintController, frame.nowSeconds);
    }

    frame.dirtyRegions = consumeDirtyRegions(paintController);

    if (frame.dirtyRegions.length > 0) {
      invalidateReader(readerEngine, frame.dirtyRegions);
    }

    return frame;
  }

  function advanceMotion(frame) {
    frame.snapshot = getTransportSnapshot(transport, frame.nowSeconds);
    frame.audioState = getAudioEngineState(audioEngine);
    updateTransportDataset(frame.snapshot);

    return frame;
  }

  function renderVisual(frame) {
    if (shouldRenderVisualFrame(frame.snapshot, frame.dirtyRegions)) {
      updateTurntableVectorPhase(
        vectorChrome,
        renderer.geometry,
        frame.snapshot.phaseTurns
      );
      renderTurntable(renderer, {
        score,
        transport: frame.snapshot,
        dirtyRegions: frame.dirtyRegions,
      });
      lastRenderedKey = createRenderedKey(frame.snapshot);
    }

    return frame;
  }

  function updateUiState(frame) {
    updateTransportControlsIfNeeded(frame.snapshot);
    if (
      frame.voiceState ||
      frame.dirtyRegions.length > 0 ||
      paintController.activeStroke
    ) {
      updatePaintControlsIfNeeded(
        false,
        frame.voiceState || getVoiceState(voiceManager)
      );
    }

    return frame;
  }

  function reconcileCurrentVisualState({ recover = false } = {}) {
    const currentNow = nowSeconds();
    const snapshot = getTransportSnapshot(transport, currentNow);
    const result = runReaderEngine(readerEngine, {
      snapshot,
      nowSeconds: currentNow,
      audioState: getAudioEngineState(audioEngine),
      force: true,
      recover,
    });

    return { snapshot, descriptorPayload: result.descriptorPayload };
  }

  async function recoverAudioAfterInterruption() {
    const audioState = getAudioEngineState(audioEngine);

    if (audioState.status !== 'ready') {
      return;
    }

    if (
      audioState.contextState === 'suspended' &&
      audioEngine.audioContext &&
      typeof audioEngine.audioContext.resume === 'function'
    ) {
      try {
        await audioEngine.audioContext.resume();
      } catch {
        return;
      }
    }

    await syncAllSampleSlots(audioEngine);
    reconcileCurrentVisualState({ recover: true });
    updatePaintControlsIfNeeded(true);
  }

  async function ensureAudioReadyFromGesture() {
    const audioState = getAudioEngineState(audioEngine);

    if (
      audioState.status === 'ready' &&
      audioState.contextState !== 'suspended'
    ) {
      return true;
    }

    if (!audioUnlockPromise) {
      audioUnlockPromise = (async () => {
        const unlockedState = await unlockAudio(audioEngine);

        if (unlockedState.status !== 'ready') {
          return false;
        }

        await syncAllSampleSlots(audioEngine);
        setLoopDefaults(audioEngine, getLoopStateSnapshot(loopState));
        reconcileCurrentVisualState({ recover: true });
        updatePaintControlsIfNeeded(true);
        return true;
      })().finally(() => {
        audioUnlockPromise = null;
      });
    }

    return audioUnlockPromise;
  }

  function runReaderTick() {
    const currentNow = nowSeconds();
    const snapshot = getTransportSnapshot(transport, currentNow);
    const result = runReaderEngine(readerEngine, {
      snapshot,
      nowSeconds: currentNow,
      audioState: getAudioEngineState(audioEngine),
    });

    if (result.voiceState) {
      updatePaintControlsIfNeeded(false, result.voiceState);
    }
  }

  function renderFrame() {
    const frame = createFrameState(nowSeconds());

    processPendingEdits(frame);
    advanceMotion(frame);
    renderVisual(frame);
    updateUiState(frame);
    animationFrameId = requestAnimationFrame(renderFrame);
  }

  function resizeAndRender() {
    const snapshot = getTransportSnapshot(transport, nowSeconds());

    resizeRenderer(renderer);
    updateTurntableVectorChrome(vectorChrome, renderer.geometry);
    centerTransportButton.updateGeometry(renderer.geometry);
    updateTurntableVectorPhase(
      vectorChrome,
      renderer.geometry,
      snapshot.phaseTurns
    );
    updateTransportDataset(snapshot);
    renderTurntable(renderer, {
      score,
      transport: snapshot,
    });
    lastRenderedKey = createRenderedKey(snapshot);
    updateTransportControlsIfNeeded(snapshot, true);
  }

  centerTransportButton.playButton.addEventListener('click', async () => {
    if (transport.isPlaying) {
      requestPause(transport, nowSeconds());
    } else {
      await ensureAudioReadyFromGesture();
      requestResume(transport, nowSeconds());
      reconcileCurrentVisualState();
      updatePaintControlsIfNeeded(true);
    }
  });
  app.addEventListener('pointerdown', clearPaintSelectionFromBackground);
  transportControls.slider.addEventListener('input', () => {
    updateTransport(transport, nowSeconds());
    setTargetGlobalSpeed(transport, Number(transportControls.slider.value));
    updateSpeedSliderFill(transportControls.slider);
  });
  for (const [colourIndex, button] of paintControls.swatchButtons.entries()) {
    button.addEventListener('click', () => {
      setSelectedColour(paintController, colourIndex);
      setTool(paintController, 'paint');
      updatePaintControlsIfNeeded(true);
    });
  }
  paintControls.eraserButton.addEventListener('click', () => {
    setTool(paintController, 'erase');
    updatePaintControlsIfNeeded(true);
  });
  paintControls.clearButton.addEventListener('click', () => {
    flushQueuedPointerEdits(nowSeconds(), { maxOperations: Infinity });
    clearPaint(paintController);
    handleScoreCleared(voiceManager);
    updatePaintControlsIfNeeded(true);
    resizeAndRender();
  });
  for (const [slotIndex, fileInput] of paintControls.fileInputs.entries()) {
    fileInput.addEventListener('click', event => {
      event.stopPropagation();
    });
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];

      const result = await replaceSlotSample(sampleManager, slotIndex, file);
      if (result.type === 'sample-replaced') {
        handleSampleReplacement(voiceManager, slotIndex, result.newVersion);
      }
      syncSampleSlot(audioEngine, slotIndex);
      if (
        result.type === 'sample-replaced' &&
        getAudioEngineState(audioEngine).status === 'ready'
      ) {
        reconcileDescriptors(
          voiceManager,
          voiceManager.lastDescriptorSnapshot,
          voiceManager.lastTransportSnapshot ||
            getTransportSnapshot(transport, nowSeconds())
        );
      }
      fileInput.value = '';
      updatePaintControlsIfNeeded(true);
    });
  }

  if (pointerEventsSupported) {
    canvas.addEventListener('pointerdown', event => {
      const eventNow = nowSeconds();

      clearPointerEditQueue(pointerEditQueue, event.pointerId);
      const result = beginStroke(
        paintController,
        {
          pointerId: event.pointerId,
          clientX: event.clientX,
          clientY: event.clientY,
          canvas,
        },
        eventNow
      );

      if (!result.started) {
        return;
      }

      event.preventDefault();

      if (typeof canvas.setPointerCapture === 'function') {
        canvas.dataset.pointerCaptureRequested = 'true';

        try {
          canvas.setPointerCapture(event.pointerId);
          canvas.dataset.pointerCaptureActive = 'true';
        } catch {
          canvas.dataset.pointerCaptureActive = 'false';
        }
      }
    });
    canvas.addEventListener('pointermove', event => {
      if (
        !paintController.activeStroke ||
        paintController.activeStroke.pointerId !== event.pointerId
      ) {
        return;
      }

      event.preventDefault();
      enqueuePointerMove(
        pointerEditQueue,
        getPointerEventSamples(event, canvas, nowSeconds())
      );
    });
    canvas.addEventListener('pointerup', event => {
      if (
        !paintController.activeStroke ||
        paintController.activeStroke.pointerId !== event.pointerId
      ) {
        return;
      }

      event.preventDefault();
      enqueuePointerEnd(
        pointerEditQueue,
        getPointerEventSamples(event, canvas, nowSeconds())
      );

      if (typeof canvas.releasePointerCapture === 'function') {
        try {
          canvas.releasePointerCapture(event.pointerId);
        } catch {
          // Synthetic browser-test pointers may not establish native capture.
        }

        canvas.dataset.pointerCaptureActive = 'false';
      }
    });
    canvas.addEventListener('pointercancel', event => {
      enqueuePointerCancel(pointerEditQueue, {
        pointerId: event.pointerId,
        clientX: event.clientX,
        clientY: event.clientY,
        canvas,
        timeSeconds: nowSeconds(),
      });
      canvas.dataset.pointerCaptureActive = 'false';
    });
  }

  if ('ResizeObserver' in window) {
    const resizeObserver = new ResizeObserver(resizeAndRender);
    resizeObserver.observe(surface);
  } else {
    window.addEventListener('resize', resizeAndRender);
  }

  function handleVisibilityRecovery() {
    if (!document.hidden) {
      recoverAudioAfterInterruption();
    }
  }

  document.addEventListener('visibilitychange', handleVisibilityRecovery);
  window.addEventListener('pageshow', recoverAudioAfterInterruption);
  window.addEventListener('focus', recoverAudioAfterInterruption);

  resizeAndRender();
  updatePaintControlsIfNeeded(true);
  readerIntervalId = window.setInterval(runReaderTick, READER_INTERVAL_MS);
  const defaultLoadPromise = loadDefaultSamples(sampleManager).finally(() => {
    updatePaintControlsIfNeeded(true);
    syncAllSampleSlots(audioEngine);
    setLoopDefaults(audioEngine, getLoopStateSnapshot(loopState));
  });
  animationFrameId = requestAnimationFrame(renderFrame);

  return {
    score,
    transport,
    renderer,
    paintController,
    playheadAnalyzer,
    scoreSync,
    readerEngine,
    voiceManager,
    loopState,
    sampleManager,
    audioEngine,
    defaultLoadPromise,
    destroy() {
      if (animationFrameId !== null) {
        cancelAnimationFrame(animationFrameId);
      }
      if (readerIntervalId !== null) {
        window.clearInterval(readerIntervalId);
      }
      destroyReaderEngine(readerEngine);
      document.removeEventListener(
        'visibilitychange',
        handleVisibilityRecovery
      );
      window.removeEventListener('pageshow', recoverAudioAfterInterruption);
      window.removeEventListener('focus', recoverAudioAfterInterruption);
    },
  };
}
