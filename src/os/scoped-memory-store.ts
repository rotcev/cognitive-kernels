import { mkdirSync } from "node:fs";
import path from "node:path";
import { OsMemoryStore } from "./memory-store.js";
import type { OsMemoryConfig, OsHeuristic, OsDagSnapshot, TopologyBlueprint, BlueprintOutcome, SchedulingStrategy, BlueprintTaskRecord, KillCalibrationData, OsProcessCheckpoint, HeuristicScope } from "./types.js";

/**
 * Composite memory store that routes heuristics to either a global store
 * (cross-project meta-learnings) or a local store (project-specific patterns).
 *
 * - Global store: lives at the configured basePath (e.g. ~/.cognitive-kernels/os/)
 * - Local store: lives at <projectDir>/.cognitive-kernels/os/
 *
 * Both stores use the same OsMemoryStore implementation with independent
 * load/save/decay/prune cycles. The composite handles routing and merging.
 *
 * Blueprints, strategies, snapshots, kill calibration, and checkpoints
 * are global-only — they're structural/meta and not project-specific.
 */
export class ScopedMemoryStore {
  readonly global: OsMemoryStore;
  readonly local: OsMemoryStore | null;

  constructor(config: OsMemoryConfig, projectDir?: string) {
    this.global = new OsMemoryStore(config);

    if (projectDir) {
      const localBasePath = path.join(projectDir, ".cognitive-kernels", "os");
      mkdirSync(localBasePath, { recursive: true });
      this.local = new OsMemoryStore({ ...config, basePath: localBasePath });
    } else {
      this.local = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Heuristics — scoped routing
  // ---------------------------------------------------------------------------

  loadHeuristics(): void {
    this.global.loadHeuristics();
    this.local?.loadHeuristics();
  }

  saveHeuristics(): void {
    this.global.saveHeuristics();
    this.local?.saveHeuristics();
  }

  /**
   * Learn a new heuristic, routing to the appropriate store based on scope.
   * Defaults to global when scope is omitted (backward compatible).
   */
  learn(
    heuristic: string,
    confidence: number,
    context: string,
    runId: string,
    snapshotId?: string,
    scope?: HeuristicScope,
  ): OsHeuristic | undefined {
    const targetScope = scope ?? "global";
    const store = targetScope === "local" && this.local ? this.local : this.global;
    return store.learn(heuristic, confidence, context, runId, snapshotId, targetScope);
  }

  /**
   * Reinforce a heuristic by ID. Looks up which store owns the ID and delegates.
   */
  reinforce(heuristicId: string): void {
    const globalH = this.global.get(heuristicId);
    if (globalH) {
      this.global.reinforce(heuristicId);
      return;
    }
    if (this.local) {
      const localH = this.local.get(heuristicId);
      if (localH) {
        this.local.reinforce(heuristicId);
        return;
      }
    }
    throw new Error(`Heuristic not found: ${heuristicId}`);
  }

  /**
   * Reinforce multiple heuristics by ID. Routes each to the owning store.
   * Returns the total count of heuristics actually reinforced.
   */
  reinforceBatch(heuristicIds: string[]): number {
    // Partition IDs by store ownership
    const globalIds: string[] = [];
    const localIds: string[] = [];
    for (const id of heuristicIds) {
      if (this.global.get(id)) {
        globalIds.push(id);
      } else if (this.local?.get(id)) {
        localIds.push(id);
      }
      // silently skip unknown IDs (matches OsMemoryStore behavior)
    }
    let count = this.global.reinforceBatch(globalIds);
    if (this.local && localIds.length > 0) {
      count += this.local.reinforceBatch(localIds);
    }
    return count;
  }

  /**
   * Penalize multiple heuristics by ID. Routes each to the owning store.
   * Returns the total count of heuristics actually penalized.
   */
  penalizeBatch(heuristicIds: string[]): number {
    const globalIds: string[] = [];
    const localIds: string[] = [];
    for (const id of heuristicIds) {
      if (this.global.get(id)) {
        globalIds.push(id);
      } else if (this.local?.get(id)) {
        localIds.push(id);
      }
    }
    let count = this.global.penalizeBatch(globalIds);
    if (this.local && localIds.length > 0) {
      count += this.local.penalizeBatch(localIds);
    }
    return count;
  }

  supersede(oldId: string, newId: string): void {
    if (this.global.get(oldId)) {
      this.global.supersede(oldId, newId);
      return;
    }
    if (this.local?.get(oldId)) {
      this.local.supersede(oldId, newId);
      return;
    }
    throw new Error(`Heuristic not found: ${oldId}`);
  }

  /**
   * Query both stores and merge results.
   * Local heuristics receive a +0.15 ranking boost to prefer project-specific knowledge.
   */
  query(queryText: string): OsHeuristic[] {
    const globalResults = this.global.query(queryText);
    if (!this.local) return globalResults;

    const localResults = this.local.query(queryText);
    if (localResults.length === 0) return globalResults;

    // Merge with local boost: assign synthetic scores based on position, then re-sort
    const LOCAL_BOOST = 0.15;
    type Scored = { h: OsHeuristic; score: number };
    const scored: Scored[] = [];

    // Score global results by descending rank position (1.0 down to near 0)
    for (let i = 0; i < globalResults.length; i++) {
      scored.push({ h: globalResults[i]!, score: 1.0 - i * (1.0 / Math.max(globalResults.length, 1)) });
    }

    // Score local results similarly but with the boost applied
    for (let i = 0; i < localResults.length; i++) {
      scored.push({ h: localResults[i]!, score: 1.0 - i * (1.0 / Math.max(localResults.length, 1)) + LOCAL_BOOST });
    }

    // Deduplicate by ID (prefer higher score)
    const byId = new Map<string, Scored>();
    for (const s of scored) {
      const existing = byId.get(s.h.id);
      if (!existing || s.score > existing.score) {
        byId.set(s.h.id, s);
      }
    }

    const merged = Array.from(byId.values());
    merged.sort((a, b) => b.score - a.score);
    return merged.map((s) => s.h);
  }

  /**
   * Get all heuristics from both stores concatenated.
   */
  getAll(): OsHeuristic[] {
    const all = this.global.getAll();
    if (this.local) {
      all.push(...this.local.getAll());
    }
    return all;
  }

  get(id: string): OsHeuristic | undefined {
    return this.global.get(id) ?? this.local?.get(id);
  }

  /**
   * Decay both stores independently.
   */
  decay(): void {
    this.global.decay();
    this.local?.decay();
  }

  /**
   * Prune both stores independently. Returns all removed heuristics.
   */
  prune(): OsHeuristic[] {
    const removed = this.global.prune();
    if (this.local) {
      removed.push(...this.local.prune());
    }
    return removed;
  }

  clearHeuristics(): void {
    this.global.clearHeuristics();
    this.local?.clearHeuristics();
  }

  get heuristicCount(): number {
    return this.global.heuristicCount + (this.local?.heuristicCount ?? 0);
  }

  // ---------------------------------------------------------------------------
  // Blueprints — global only
  // ---------------------------------------------------------------------------

  loadBlueprints(): void {
    this.global.loadBlueprints();
  }

  saveBlueprints(): void {
    this.global.saveBlueprints();
  }

  addBlueprint(blueprint: TopologyBlueprint): void {
    this.global.addBlueprint(blueprint);
  }

  getBlueprint(id: string): TopologyBlueprint | undefined {
    return this.global.getBlueprint(id);
  }

  getAllBlueprints(): TopologyBlueprint[] {
    return this.global.getAllBlueprints();
  }

  queryBlueprints(goal: string): TopologyBlueprint[] {
    return this.global.queryBlueprints(goal);
  }

  recordBlueprintOutcome(outcome: BlueprintOutcome): void {
    this.global.recordBlueprintOutcome(outcome);
  }

  get blueprintCount(): number {
    return this.global.blueprintCount;
  }

  pruneBlueprints(minUses: number, minFitnessRatio: number): number {
    return this.global.pruneBlueprints(minUses, minFitnessRatio);
  }

  recordBlueprintTask(record: BlueprintTaskRecord): void {
    this.global.recordBlueprintTask(record);
  }

  recommendBlueprint(taskClass: string[], availableBlueprints: TopologyBlueprint[]): TopologyBlueprint {
    return this.global.recommendBlueprint(taskClass, availableBlueprints);
  }

  // ---------------------------------------------------------------------------
  // Snapshots — global only
  // ---------------------------------------------------------------------------

  saveSnapshot(snapshot: OsDagSnapshot): void {
    this.global.saveSnapshot(snapshot);
  }

  loadSnapshots(runId: string): OsDagSnapshot[] {
    return this.global.loadSnapshots(runId);
  }

  loadLatestSnapshot(runId: string): OsDagSnapshot | undefined {
    return this.global.loadLatestSnapshot(runId);
  }

  // ---------------------------------------------------------------------------
  // Scheduling Strategies — global only
  // ---------------------------------------------------------------------------

  saveSchedulingStrategy(strategy: SchedulingStrategy): void {
    this.global.saveSchedulingStrategy(strategy);
  }

  getSchedulingStrategies(): SchedulingStrategy[] {
    return this.global.getSchedulingStrategies();
  }

  recordStrategyOutcome(id: string, success: boolean, tokensToCompletion?: number): void {
    this.global.recordStrategyOutcome(id, success, tokensToCompletion);
  }

  pruneStrategies(minUses: number, minFitnessRatio: number): SchedulingStrategy[] {
    return this.global.pruneStrategies(minUses, minFitnessRatio);
  }

  // ---------------------------------------------------------------------------
  // Kill Calibration — global only
  // ---------------------------------------------------------------------------

  getKillCalibration(): KillCalibrationData | null {
    return this.global.getKillCalibration();
  }

  setKillCalibration(data: KillCalibrationData): void {
    this.global.setKillCalibration(data);
  }

  // ---------------------------------------------------------------------------
  // Checkpoints — global only
  // ---------------------------------------------------------------------------

  saveCheckpoint(checkpoint: OsProcessCheckpoint): void {
    this.global.saveCheckpoint(checkpoint);
  }

  loadCheckpoint(runId: string, pid: string): OsProcessCheckpoint | null {
    return this.global.loadCheckpoint(runId, pid);
  }

  loadCheckpoints(runId: string): OsProcessCheckpoint[] {
    return this.global.loadCheckpoints(runId);
  }

  listCheckpointRuns(): string[] {
    return this.global.listCheckpointRuns();
  }

  pruneCheckpoints(maxAgeMs?: number): number {
    return this.global.pruneCheckpoints(maxAgeMs);
  }

  // ---------------------------------------------------------------------------
  // Promotion & Shutdown — global only
  // ---------------------------------------------------------------------------

  promoteHeuristics(): number {
    return this.global.promoteHeuristics();
  }

  shutdown(): void {
    this.global.shutdown();
    // Local store doesn't need promotion/strategy pruning — it's heuristics-only
  }

  // ---------------------------------------------------------------------------
  // Consolidation Markers — global only
  // ---------------------------------------------------------------------------

  hasNewEpisodicData(): boolean {
    return this.global.hasNewEpisodicData();
  }

  markConsolidated(): void {
    this.global.markConsolidated();
  }
}
