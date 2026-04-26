import { PLAYHEAD_CONFIG } from "./config.js";

export function createInitialPlayheadState() {
  return Object.freeze({
    status: "sensor_geometry_and_score_reader",
    analysisState: "local_island_descriptors",
    analysisSubsteps: PLAYHEAD_CONFIG.analysisSubsteps,
    adjacency: PLAYHEAD_CONFIG.adjacency,
    maxDescriptorsPerSlot: PLAYHEAD_CONFIG.maxDescriptorsPerSlot,
    maxTotalDescriptors: PLAYHEAD_CONFIG.maxTotalDescriptors
  });
}
