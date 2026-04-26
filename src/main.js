import "@fontsource/nunito/latin-300.css";
import "./styles.css";

import { APP_CONFIG, PHASE_08_STATE } from "./config.js";
import { detectCapabilities } from "./capabilities.js";
import { createAppAudioEngine, createInitialAudioState } from "./audio.js";
import { createInitialPaintState } from "./paint.js";
import { createInitialPlayheadState } from "./playhead.js";
import { createInitialPlayheadAnalysisState } from "./playhead-analyzer.js";
import { createRendererPlaceholder } from "./renderer.js";
import { createAppSampleManager, createInitialSampleState } from "./samples.js";
import { createInitialScoreState, createScore } from "./score.js";
import { createInitialScoreSyncState } from "./score-sync.js";
import { createInitialTransportState, createTransport } from "./transport.js";
import { mountAppShell } from "./ui.js";
import { createInitialVoiceState } from "./voice-manager.js";
import { createInitialLoopState } from "./loop-state.js";

const root = document.querySelector("#app");

if (!root) {
  throw new Error("App mount node was not found.");
}

const sampleManager = createAppSampleManager(window);
const audioEngine = createAppAudioEngine({ sampleManager, scope: window });

mountAppShell(root, {
  config: APP_CONFIG,
  phaseState: PHASE_08_STATE,
  capabilities: detectCapabilities(window),
  score: createScore(),
  transport: createTransport(),
  sampleManager,
  audioEngine,
  moduleStates: {
    transport: createInitialTransportState(),
    score: createInitialScoreState(),
    sync: createInitialScoreSyncState(),
    renderer: createRendererPlaceholder(),
    paint: createInitialPaintState(),
    playhead: createInitialPlayheadState(),
    analysis: createInitialPlayheadAnalysisState(),
    audio: createInitialAudioState(),
    voices: createInitialVoiceState(),
    loop: createInitialLoopState(),
    samples: createInitialSampleState()
  }
});
