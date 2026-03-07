/**
 * Lens — the observability layer for cognitive kernels.
 *
 * Transforms raw kernel telemetry into legible, real-time views.
 */

// Core pipeline
export { classifyRole } from "./role-classifier.js";
export { StreamSegmenter } from "./stream-segmenter.js";
export { buildLensSnapshot, previewValue } from "./view-models.js";
export { diffSnapshots } from "./snapshot-differ.js";

// Real-time infrastructure
export { LensEventBus } from "./event-bus.js";
export type { LensBusEvent } from "./event-bus.js";
export { LensServer } from "./server.js";
export type { LensServerOptions } from "./server.js";
export { LensStoragePoller } from "./file-watcher.js";
export type { StoragePollerOptions } from "./file-watcher.js";
export { LensSession } from "./session.js";
export type { LensSessionOptions } from "./session.js";

// Narrative
export { NarrativeGenerator, createAnthropicNarrator, createOpenAINarrator } from "./narrative.js";
export type { NarrativeGenerateFn, NarrativeGeneratorOptions, NarrativeResult } from "./narrative.js";

// Client (for white-label embedding — future `cognitive-lens` package)
export { LensClient } from "./client.js";
export type { LensClientOptions, LensClientEventMap } from "./client.js";

// Types
export type * from "./types.js";
