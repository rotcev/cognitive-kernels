export { flatten } from "./flatten.js";
export { validateTopology } from "./validate.js";
export { reconcile } from "./reconcile.js";
export type { ReconcileEffect } from "./reconcile.js";
export { evaluateGateCondition } from "./gates.js";
export { optimizeTopology } from "./optimize.js";
export { autoArrange } from "./auto-arrange.js";
export type {
  TopologyExpr,
  TaskBackend,
  GateCondition,
  FlatNode,
  FlatGraph,
  TopologyValidationError,
  TopologyValidationResult,
  OptWarning,
  MetacogOutput,
  MetacogMemoryCommand,
} from "./types.js";
