export const APP_CONFIG = Object.freeze({
  appName: "Turntable",
  phaseLabel: "Phase 08",
  colourCount: 6,
  buildTarget: "static",
  deployment: Object.freeze({
    host: "vercel",
    preferredDomainType: "subdomain"
  }),
  paths: Object.freeze({
    worklets: "/worklets/",
    samples: "/samples/"
  })
});

export const SCORE_CONFIG = Object.freeze({
  angleColumns: 4096,
  radialRows: 256,
  colourCount: APP_CONFIG.colourCount
});

export const TRANSPORT_CONFIG = Object.freeze({
  baseRevolutionSeconds: 8,
  globalSpeedMin: -4,
  globalSpeedMax: 4,
  defaultTargetGlobalSpeed: 1,
  defaultPhaseTurns: 0,
  defaultIsPlaying: false,
  pauseDecelerationMs: 500,
  resumeAccelerationMs: 350,
  nearZeroSpeedThreshold: 0.02
});

export const GEOMETRY_CONFIG = Object.freeze({
  playheadAngleTurns: -0.25,
  discPaddingRatio: 0,
  hubRadiusRatio: 0.115,
  innerPlayableRadiusRatio: 0.115,
  radialRateMin: 0.5,
  radialRateMid: 1,
  radialRateMax: 2
});

export const PLAYHEAD_CONFIG = Object.freeze({
  strokeWidthMinPx: 5,
  strokeWidthRatio: 0.014,
  coreWidthMinPx: 2,
  coreWidthRatio: 0.009,
  outerExtensionPx: 0,
  innerExtensionPx: 5,
  coreInsetPx: 2,
  analysisSubsteps: "adaptive",
  adjacency: "8-way",
  maxDescriptorsPerSlot: 4,
  maxTotalDescriptors: 24
});

export const BRUSH_CONFIG = Object.freeze({
  minRadiusRatio: 0.0075,
  maxRadiusRatio: 0.05625,
  fixedClickRadiusRatio: 0.033,
  speedForMaxRadiusPxPerSecond: 900,
  smoothing: 0.35,
  stampSpacingRatio: 0.65
});

export const SAMPLE_CONFIG = Object.freeze({
  maxSampleSeconds: null,
  acceptedFileTypes: "audio/*",
  defaultBasePath: "/samples/default/"
});

export const AUDIO_CONFIG = Object.freeze({
  workletUrl: "/worklets/sampler-worklet.js",
  processorName: "turntable-sampler",
  maxEffectivePlaybackRate: 8,
  ampSmoothMs: 10,
  rateSmoothMs: 10,
  fadeOutMs: 4,
  masterGain: 0.75,
  maxVoiceAmplitude: 1,
  outputLimit: 0.98,
  globalLoopMode: false
});

export const VOICE_CONFIG = Object.freeze({
  maxVoicesPerSlot: 4,
  maxTotalVoices: 24,
  maxMatchRadialDistance: 0.18,
  minTriggerPlaybackRate: 0.0001,
  minAudiblePlaybackRate: TRANSPORT_CONFIG.nearZeroSpeedThreshold,
  amplitudeCurve: 2.2,
  amplitudeCoverageWeight: 0.75,
  amplitudeStrengthWeight: 0.25,
  minAudibleAmplitude: 0.04,
  fadeOutMs: AUDIO_CONFIG.fadeOutMs,
  playFullSampleOnTrigger: true
});

export const PERFORMANCE_CONFIG = Object.freeze({
  scoreSyncPreferredMode: "auto",
  dirtyMessageFallbackRequired: true,
  sharedBufferPageCount: 2,
  maxDirtyRegionsPerPayload: 64,
  analysisProfileSpeeds: Object.freeze([0.5, 1, 4]),
  renderProfileScoreStates: Object.freeze(["empty", "sparse", "dense"]),
  qaRepresentativeViewports: Object.freeze([
    Object.freeze({ width: 390, height: 760, label: "mobile" }),
    Object.freeze({ width: 1024, height: 768, label: "tablet" }),
    Object.freeze({ width: 1440, height: 1100, label: "desktop" })
  ])
});

export const SCORE_PALETTE = Object.freeze([
  null,
  Object.freeze({
    name: "White",
    family: "white",
    futureDefaultSample: "Kick",
    color: "#ffffff"
  }),
  Object.freeze({
    name: "Vermilion orange",
    family: "vermilion orange",
    futureDefaultSample: "Snare",
    color: "#ff5a00"
  }),
  Object.freeze({
    name: "Soft yellow",
    family: "soft yellow",
    futureDefaultSample: "Hat",
    color: "#ffe600"
  }),
  Object.freeze({
    name: "Mint",
    family: "mint / green",
    futureDefaultSample: "Perc",
    color: "#00c83a"
  }),
  Object.freeze({
    name: "Blue",
    family: "blue",
    futureDefaultSample: "Blip",
    color: "#004dff"
  }),
  Object.freeze({
    name: "Violet",
    family: "violet",
    futureDefaultSample: "Bloom",
    color: "#7a00ff"
  })
]);

export const PHASE_00_STATE = Object.freeze({
  project_state: "static_js_app_shell",
  deployment_state: "vercel_ready",
  runtime_state: "non_musical_shell"
});

export const PHASE_01_STATE = Object.freeze({
  project_state: "silent_turntable_foundation",
  runtime_state: "visual_disc_with_transport",
  score_state: "authoritative_polar_grid",
  transport_state: "signed_phase_model",
  renderer_state: "score_driven_canvas_disc"
});

export const PHASE_02_STATE = Object.freeze({
  project_state: "paintable_polar_score_turntable",
  runtime_state: "silent_paintable_disc",
  score_state: "user_editable_polar_grid",
  transport_state: "signed_phase_model",
  renderer_state: "score_driven_canvas_disc",
  editing_state: "paint_erase_clear"
});

export const PHASE_03_STATE = Object.freeze({
  project_state: "paintable_turntable_with_sample_slots",
  runtime_state: "silent_sample_ready_disc",
  score_state: "user_editable_polar_grid",
  transport_state: "signed_phase_model",
  renderer_state: "score_driven_canvas_disc",
  editing_state: "paint_erase_clear",
  sample_state: "decoded_slot_samples_available",
  slot_state: "six_colour_sample_slots"
});

export const PHASE_04_STATE = Object.freeze({
  project_state: "audio_worklet_sampler_foundation",
  runtime_state: "sample_engine_available",
  score_state: "user_editable_polar_grid",
  transport_state: "signed_phase_model",
  renderer_state: "score_driven_canvas_disc",
  editing_state: "paint_erase_clear",
  sample_state: "decoded_samples_synced_to_worklet",
  slot_state: "six_colour_sample_slots",
  audio_state: "controlled_sampler_core"
});

export const PHASE_05_STATE = Object.freeze({
  project_state: "optical_reader_foundation",
  runtime_state: "descriptor_ready_turntable",
  score_state: "user_editable_polar_grid",
  transport_state: "signed_phase_model",
  renderer_state: "score_driven_canvas_disc",
  editing_state: "paint_erase_clear",
  sample_state: "decoded_samples_synced_to_worklet",
  slot_state: "six_colour_sample_slots",
  audio_state: "controlled_sampler_core",
  playhead_state: "sensor_geometry_and_score_reader",
  analysis_state: "local_island_descriptors"
});

export const PHASE_06_STATE = Object.freeze({
  project_state: "playable_optical_sample_turntable",
  runtime_state: "descriptor_driven_audio",
  score_state: "user_editable_polar_grid",
  transport_state: "signed_phase_model",
  renderer_state: "score_driven_canvas_disc",
  editing_state: "paint_erase_clear",
  sample_state: "decoded_samples_synced_to_worklet",
  slot_state: "six_colour_sample_slots",
  audio_state: "playhead_driven_sampler",
  playhead_state: "sensor_geometry_and_score_reader",
  analysis_state: "voice_reconciled_descriptors",
  voice_state: "matched_local_island_voices"
});

export const PHASE_07_STATE = Object.freeze({
  project_state: "v1_feature_complete_instrument",
  runtime_state: "transport_polished_optical_turntable",
  score_state: "user_editable_polar_grid",
  transport_state: "ramped_audio_clock_transport",
  renderer_state: "score_driven_canvas_disc",
  editing_state: "paint_erase_clear",
  sample_state: "decoded_samples_synced_to_worklet",
  slot_state: "six_colour_sample_slots",
  audio_state: "playhead_driven_sampler",
  playhead_state: "sensor_geometry_and_score_reader",
  analysis_state: "voice_reconciled_descriptors",
  voice_state: "matched_local_island_voices",
  loop_ui_state: "global_and_per_slot_controls",
  ui_state: "v1_complete_controls"
});

export const PHASE_08_STATE = Object.freeze({
  project_state: "v1_release_candidate",
  runtime_state: "hardened_optical_turntable",
  score_state: "user_editable_polar_grid",
  transport_state: "ramped_audio_clock_transport",
  renderer_state: "score_driven_canvas_disc",
  editing_state: "paint_erase_clear",
  sample_state: "decoded_samples_synced_to_worklet",
  slot_state: "six_colour_sample_slots",
  audio_state: "playhead_driven_sampler",
  playhead_state: "sensor_geometry_and_score_reader",
  analysis_state: "voice_reconciled_descriptors",
  voice_state: "matched_local_island_voices",
  loop_ui_state: "global_and_per_slot_controls",
  performance_state: "profiled_and_tuned",
  sync_state: "shared_buffer_or_dirty_message_fallback",
  deployment_state: "vercel_release_ready",
  qa_state: "release_checked"
});
