/**
 * cognitive-lens — framework-agnostic observability client for cognitive kernels.
 *
 * Zero dependencies. Works in browsers and Node.js.
 * Products import from this package to embed Lens UI.
 */

// Client
export { LensClient } from "./client.js";
export type { LensClientOptions, LensClientEventMap } from "./client.js";

// Cognitive events
export { extractCognitiveEvent } from "./cognitive-events.js";
export type {
  LensCognitiveEvent,
  LensCognitiveCategory,
  LensCognitiveEventBase,
  LensCognitiveDecisionSpawn,
  LensCognitiveDecisionKill,
  LensCognitiveDecisionDefer,
  LensCognitiveDecisionShellSpawn,
  LensCognitiveDecisionSubkernelSpawn,
  LensCognitivePlanningBlueprint,
  LensCognitiveObservationAwareness,
  LensCognitiveObservationSelfReport,
  LensCognitiveInterventionMetacog,
  LensCognitiveInterventionOutcome,
  LensCognitiveLearningHeuristic,
} from "./cognitive-events.js";

// Types
export type * from "./types.js";
