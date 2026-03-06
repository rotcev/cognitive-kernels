import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  unlinkSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";
import type { OsHeuristic, OsDagSnapshot, OsMemoryConfig, TopologyBlueprint, BlueprintOutcome, BlueprintTagStats, SchedulingStrategy, PromotionLogEntry, BlueprintTaskRecord, KillCalibrationData, OsProcessCheckpoint, HeuristicScope } from "./types.js";
export type { SchedulingStrategy };

// ─── Memory File Shape ───────────────────────────────────────────────
interface MemoryData {
  heuristics: OsHeuristic[];
  promotionLog: PromotionLogEntry[];
  blueprintTaskHistory?: BlueprintTaskRecord[];
}
import { SEED_BLUEPRINTS } from "./seed-blueprints.js";

// ─── Goal Tag Vocabulary ────────────────────────────────────────────
const GOAL_TAG_PATTERNS: Record<string, string[]> = {
  "code": ["implement", "code", "build", "create", "write", "develop", "program"],
  "research": ["research", "analyze", "investigate", "explore", "study", "compare", "evaluate"],
  "transform": ["transform", "migrate", "convert", "refactor", "process", "pipeline"],
  "generate": ["generate", "produce", "synthesize", "compose", "draft"],
  "fix": ["fix", "debug", "repair", "resolve", "patch"],
  "test": ["test", "verify", "validate", "check", "assert"],
  "design": ["design", "architect", "plan", "structure", "layout"],
  "deploy": ["deploy", "release", "publish", "ship", "launch"],
};

/**
 * Extract goal tags by keyword matching against a vocabulary.
 */
export function extractGoalTags(goal: string): string[] {
  const words = goal.toLowerCase().split(/\s+/);
  const tags: string[] = [];
  for (const [tag, patterns] of Object.entries(GOAL_TAG_PATTERNS)) {
    if (patterns.some((p) => words.some((w) => w.includes(p) || p.includes(w)))) {
      tags.push(tag);
    }
  }
  return tags;
}

// ─── Bayesian Sampling ──────────────────────────────────────────────

/**
 * Sample from a Beta(alpha, beta) distribution using Gamma ratio.
 * Uses Box-Muller + Marsaglia-Tsang Gamma generation. Pure math, no deps.
 */
export function sampleBeta(alpha: number, beta: number): number {
  const x = sampleGamma(alpha);
  const y = sampleGamma(beta);
  if (x + y === 0) return 0.5;
  return x / (x + y);
}

/** Standard normal via Box-Muller transform. */
function sampleNormal(): number {
  let u1 = 0;
  let u2 = 0;
  while (u1 === 0) u1 = Math.random();
  while (u2 === 0) u2 = Math.random();
  return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
}

/**
 * Sample from Gamma(shape, 1) using Marsaglia-Tsang method.
 * For shape < 1, uses the Ahrens-Dieter boost: Gamma(a) = Gamma(a+1) * U^(1/a).
 */
function sampleGamma(shape: number): number {
  if (shape <= 0) return 0;
  if (shape < 1) {
    // Boost: Gamma(a) = Gamma(a+1) * U^(1/a)
    const u = Math.random();
    return sampleGamma(shape + 1) * Math.pow(u, 1.0 / shape);
  }

  const d = shape - 1.0 / 3.0;
  const c = 1.0 / Math.sqrt(9.0 * d);

  for (;;) {
    let x: number;
    let v: number;
    do {
      x = sampleNormal();
      v = 1.0 + c * x;
    } while (v <= 0);

    v = v * v * v;
    const u = Math.random();
    if (u < 1.0 - 0.0331 * (x * x) * (x * x)) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1.0 - v + Math.log(v))) return d * v;
  }
}

// ─── Jaccard Similarity ─────────────────────────────────────────────

/** Compute word-fingerprint Jaccard similarity between two strings. */
function wordJaccard(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\W+/).filter((w) => w.length > 2));
  const wordsB = new Set(b.toLowerCase().split(/\W+/).filter((w) => w.length > 2));
  const union = new Set([...wordsA, ...wordsB]);
  if (union.size === 0) return 0;
  const intersection = new Set([...wordsA].filter((w) => wordsB.has(w)));
  return intersection.size / union.size;
}

export class OsMemoryStore {
  private readonly config: OsMemoryConfig;
  private heuristics: Map<string, OsHeuristic> = new Map();
  private blueprints: Map<string, TopologyBlueprint> = new Map();
  private strategies: Map<string, SchedulingStrategy> = new Map();
  private strategiesLoaded = false;
  private promotionLog: PromotionLogEntry[] = [];
  private blueprintTaskHistory: BlueprintTaskRecord[] = [];

  constructor(config: OsMemoryConfig) {
    this.config = config;
  }

  // ---------------------------------------------------------------------------
  // Heuristics (Long-term memory)
  // ---------------------------------------------------------------------------

  loadHeuristics(): void {
    const filePath = path.join(this.config.basePath, "memory.json");
    if (!existsSync(filePath)) {
      return;
    }
    const raw = readFileSync(filePath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    this.heuristics.clear();
    this.promotionLog = [];

    let arr: OsHeuristic[];
    if (Array.isArray(parsed)) {
      // Legacy format: plain array of heuristics
      arr = parsed as OsHeuristic[];
    } else if (parsed && typeof parsed === "object" && Array.isArray((parsed as MemoryData).heuristics)) {
      // New format: { heuristics: [], promotionLog: [], blueprintTaskHistory?: [] }
      const data = parsed as MemoryData;
      arr = data.heuristics;
      this.promotionLog = Array.isArray(data.promotionLog) ? data.promotionLog : [];
      this.blueprintTaskHistory = Array.isArray(data.blueprintTaskHistory) ? data.blueprintTaskHistory : [];
    } else {
      arr = [];
    }

    for (const h of arr) {
      // Defensive: ensure confidence is a valid number (disk entries may be corrupted)
      if (typeof h.confidence !== "number" || isNaN(h.confidence)) {
        h.confidence = 0.3; // assign modest default for entries missing confidence
      }
      this.heuristics.set(h.id, h);
    }
  }

  saveHeuristics(): void {
    const dirPath = this.config.basePath;
    mkdirSync(dirPath, { recursive: true });
    const filePath = path.join(dirPath, "memory.json");
    const data: MemoryData = {
      heuristics: Array.from(this.heuristics.values()),
      promotionLog: this.promotionLog,
      blueprintTaskHistory: this.blueprintTaskHistory.length > 0 ? this.blueprintTaskHistory : undefined,
    };
    writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  }

  learn(
    heuristic: string,
    confidence: number,
    context: string,
    runId: string,
    snapshotId?: string,
    scope?: HeuristicScope,
  ): OsHeuristic | undefined {
    // Noise gate: reject heuristics with near-zero confidence — these are typically
    // auto-generated correlation records with no real signal.
    const MIN_CONFIDENCE_TO_ACCEPT = 0.15;
    if (confidence < MIN_CONFIDENCE_TO_ACCEPT) {
      return undefined;
    }

    // Dedup: if a similar heuristic already exists (Jaccard >= 0.7), reinforce it instead
    for (const existing of this.heuristics.values()) {
      if (existing.supersededBy) continue;
      if (wordJaccard(existing.heuristic, heuristic) >= 0.7) {
        existing.reinforcementCount += 1;
        existing.confidence = Math.max(existing.confidence, confidence);
        existing.reinforcedAt = new Date().toISOString();
        this.saveHeuristics();
        return existing;
      }
    }

    if (this.heuristics.size >= this.config.maxHeuristics) {
      throw new Error(
        `Max heuristics limit reached (${this.config.maxHeuristics})`,
      );
    }

    // Cap initial confidence — LLM's stated confidence is a prior, not a validated
    // belief. New heuristics must earn higher confidence through reinforcement.
    const MAX_INITIAL_CONFIDENCE = 0.5;
    const cappedConfidence = Math.min(confidence, MAX_INITIAL_CONFIDENCE);

    const now = new Date().toISOString();
    const entry: OsHeuristic = {
      id: randomUUID(),
      heuristic,
      confidence: cappedConfidence,
      context,
      source: {
        runId,
        snapshotId,
      },
      reinforcementCount: 0,
      learnedAt: now,
      reinforcedAt: now,
      ...(scope ? { scope } : {}),
    };

    this.heuristics.set(entry.id, entry);
    this.saveHeuristics();
    return entry;
  }

  reinforce(heuristicId: string): void {
    const h = this.heuristics.get(heuristicId);
    if (!h) {
      throw new Error(`Heuristic not found: ${heuristicId}`);
    }
    h.reinforcementCount += 1;
    h.reinforcedAt = new Date().toISOString();
    // Boost confidence proportional to reinforcement — diminishing returns via 1/(1+count)
    // This counteracts decay() so validated heuristics don't ratchet to zero.
    const boost = this.config.heuristicDecayRate * 2 / (1 + h.reinforcementCount * 0.1);
    h.confidence = Math.min(1, h.confidence + boost);
    this.saveHeuristics();
  }

  supersede(oldId: string, newId: string): void {
    const old = this.heuristics.get(oldId);
    if (!old) {
      throw new Error(`Heuristic not found: ${oldId}`);
    }
    old.supersededBy = newId;
    this.saveHeuristics();
  }

  query(queryText: string): OsHeuristic[] {
    // Use wordJaccard as the primary ranking signal.
    // Heuristics scoring below the threshold are excluded from results.
    const JACCARD_THRESHOLD = 0.1;

    const scored: Array<{ h: OsHeuristic; jaccard: number }> = [];
    for (const h of this.heuristics.values()) {
      if (h.supersededBy) {
        continue;
      }
      const hText = `${h.heuristic} ${h.context}`;
      const jaccard = wordJaccard(queryText, hText);
      if (jaccard >= JACCARD_THRESHOLD) {
        scored.push({ h, jaccard });
      }
    }

    // Sort by wordJaccard descending (primary), then confidence descending (secondary)
    scored.sort((a, b) => {
      const byJaccard = b.jaccard - a.jaccard;
      if (byJaccard !== 0) return byJaccard;
      return b.h.confidence - a.h.confidence;
    });

    return scored.map((s) => s.h);
  }

  getAll(): OsHeuristic[] {
    return Array.from(this.heuristics.values());
  }

  get(id: string): OsHeuristic | undefined {
    return this.heuristics.get(id);
  }

  decay(): void {
    const now = Date.now();
    for (const h of this.heuristics.values()) {
      // Skip decay for heuristics reinforced in the last 60 seconds
      const reinforcedAt = h.reinforcedAt ? new Date(h.reinforcedAt).getTime() : 0;
      if (now - reinforcedAt < 60_000) continue;
      h.confidence = Math.max(0, h.confidence - this.config.heuristicDecayRate);
    }
    this.saveHeuristics();
  }

  prune(): OsHeuristic[] {
    const removed: OsHeuristic[] = [];
    for (const [id, h] of this.heuristics) {
      if (h.confidence < this.config.heuristicPruneThreshold) {
        removed.push(h);
        this.heuristics.delete(id);
      }
    }
    this.saveHeuristics();
    return removed;
  }

  // ---------------------------------------------------------------------------
  // Topology Blueprints (Structural memory)
  // ---------------------------------------------------------------------------

  loadBlueprints(): void {
    const filePath = path.join(this.config.basePath, "blueprints.json");
    if (existsSync(filePath)) {
      const raw = readFileSync(filePath, "utf-8");
      const arr: TopologyBlueprint[] = JSON.parse(raw);
      this.blueprints.clear();
      for (const bp of arr) {
        // Migration: backfill Bayesian fields for old data
        if (bp.stats.alpha === undefined) {
          bp.stats.alpha = (bp.stats.successes || 0) + 1;
          bp.stats.beta = (bp.stats.failures || 0) + 1;
          bp.stats.tagStats = {};
        }
        this.blueprints.set(bp.id, bp);
      }
    }

    // Ensure seed blueprints exist (idempotent)
    for (const seed of SEED_BLUEPRINTS) {
      if (!this.blueprints.has(seed.id)) {
        this.blueprints.set(seed.id, { ...seed });
      }
    }
  }

  saveBlueprints(): void {
    const dirPath = this.config.basePath;
    mkdirSync(dirPath, { recursive: true });
    const filePath = path.join(dirPath, "blueprints.json");
    const arr = Array.from(this.blueprints.values());
    writeFileSync(filePath, JSON.stringify(arr, null, 2), "utf-8");
  }

  addBlueprint(blueprint: TopologyBlueprint): void {
    this.blueprints.set(blueprint.id, blueprint);
    this.saveBlueprints();
  }

  getBlueprint(id: string): TopologyBlueprint | undefined {
    return this.blueprints.get(id);
  }

  getAllBlueprints(): TopologyBlueprint[] {
    return Array.from(this.blueprints.values());
  }

  /**
   * Query blueprints ranked by relevance to the goal.
   * Scoring: keyword match + Thompson Sampling from Beta distribution.
   * Uses tag-specific alpha/beta when >= 3 observations exist, else global.
   */
  queryBlueprints(goal: string): TopologyBlueprint[] {
    const words = goal.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    const goalTags = extractGoalTags(goal);
    const scored: Array<{ bp: TopologyBlueprint; score: number }> = [];

    for (const bp of this.blueprints.values()) {
      let score = 0;

      // Keyword match against applicability patterns
      for (const pattern of bp.applicability.goalPatterns) {
        if (words.some((w) => w.includes(pattern) || pattern.includes(w))) {
          score += 10;
        }
      }

      // Description match
      const descWords = `${bp.description} ${bp.name}`.toLowerCase();
      for (const w of words) {
        if (descWords.includes(w)) score += 1;
      }

      // Thompson Sampling: sample from Beta distribution instead of deterministic rate
      // Use tag-specific stats when we have enough observations, else global
      let alpha = bp.stats.alpha ?? 1;
      let beta = bp.stats.beta ?? 1;

      if (goalTags.length > 0 && bp.stats.tagStats) {
        // Find best tag-specific stats with >= 3 observations
        let bestTagObs = 0;
        for (const tag of goalTags) {
          const ts = bp.stats.tagStats[tag];
          if (ts && ts.observations >= 3 && ts.observations > bestTagObs) {
            alpha = ts.alpha;
            beta = ts.beta;
            bestTagObs = ts.observations;
          }
        }
      }

      // Sample from Beta(alpha, beta) — this provides natural exploration/exploitation
      const sample = sampleBeta(alpha, beta);

      // Efficiency bonus: reward blueprints with lower tokens-per-process
      // avgTokenEfficiency is 0 when no data yet → use neutral 0.5 bonus
      const avgTokensPerProcess = bp.stats.avgTokenEfficiency;
      const efficiencyBonus = avgTokensPerProcess > 0
        ? 1.0 / (1.0 + avgTokensPerProcess / 10000)
        : 0.5;
      const finalScore = sample * (1.0 + efficiencyBonus * 0.1);
      score += finalScore * 20;

      scored.push({ bp, score });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.bp);
  }

  /**
   * Record the outcome of a blueprint usage.
   * Applies 0.95 recency decay on existing alpha/beta, then adds fractional score.
   * Updates per-tag stats and keeps legacy counters for backward compat.
   */
  recordBlueprintOutcome(outcome: BlueprintOutcome): void {
    const bp = this.blueprints.get(outcome.blueprintId);
    if (!bp) return;

    if (!bp.stats) {
      bp.stats = { uses: 0, successes: 0, failures: 0, avgTokenEfficiency: 0, avgWallTimeMs: 0, lastUsedAt: "", alpha: 1, beta: 1, tagStats: {} };
    }
    const s = bp.stats;
    const DECAY = 0.95;
    const score = outcome.completionScore ?? (outcome.success ? 1 : 0);

    // Legacy counters (keep for backward compat)
    s.uses += 1;
    if (outcome.success) {
      s.successes += 1;
    } else {
      s.failures += 1;
    }

    // Recency decay on existing Bayesian params, then add fractional score
    s.alpha = (s.alpha ?? 1) * DECAY + score;
    s.beta = (s.beta ?? 1) * DECAY + (1 - score);

    // Per-tag stats update
    if (!s.tagStats) s.tagStats = {};
    const tags = outcome.goalTags ?? [];
    for (const tag of tags) {
      if (!s.tagStats[tag]) {
        s.tagStats[tag] = { alpha: 1, beta: 1, observations: 0 };
      }
      const ts = s.tagStats[tag]!;
      ts.alpha = ts.alpha * DECAY + score;
      ts.beta = ts.beta * DECAY + (1 - score);
      ts.observations += 1;
    }

    // Running averages
    const n = s.uses;
    // Token efficiency = tokens-per-completed-process (not raw total, which varies with problem size)
    const tokenEfficiency = outcome.completedProcessCount > 0
      ? outcome.totalTokens / outcome.completedProcessCount
      : outcome.totalTokens;
    s.avgTokenEfficiency = s.avgTokenEfficiency + (tokenEfficiency - s.avgTokenEfficiency) / n;
    s.avgWallTimeMs = s.avgWallTimeMs + (outcome.wallTimeMs - s.avgWallTimeMs) / n;
    s.lastUsedAt = new Date().toISOString();

    this.saveBlueprints();
  }

  get blueprintCount(): number {
    return this.blueprints.size;
  }

  // ---------------------------------------------------------------------------
  // DAG Snapshots (Episodic memory)
  // ---------------------------------------------------------------------------

  saveSnapshot(snapshot: OsDagSnapshot): void {
    const dirPath = path.join(
      this.config.basePath,
      "snapshots",
      snapshot.runId,
    );
    mkdirSync(dirPath, { recursive: true });
    const filePath = path.join(dirPath, `${snapshot.id}.json`);
    writeFileSync(filePath, JSON.stringify(snapshot, null, 2), "utf-8");
  }

  loadSnapshots(runId: string): OsDagSnapshot[] {
    const dirPath = path.join(this.config.basePath, "snapshots", runId);
    if (!existsSync(dirPath)) {
      return [];
    }

    const files = readdirSync(dirPath).filter((f) => f.endsWith(".json"));

    const snapshots: OsDagSnapshot[] = [];
    for (const file of files) {
      const raw = readFileSync(path.join(dirPath, file), "utf-8");
      snapshots.push(JSON.parse(raw) as OsDagSnapshot);
    }

    snapshots.sort(
      (a, b) =>
        new Date(a.capturedAt).getTime() - new Date(b.capturedAt).getTime(),
    );
    return snapshots;
  }

  loadLatestSnapshot(runId: string): OsDagSnapshot | undefined {
    const snapshots = this.loadSnapshots(runId);
    return snapshots.length > 0 ? snapshots[snapshots.length - 1] : undefined;
  }

  // ---------------------------------------------------------------------------
  // Scheduling Strategies (Cross-run scheduling memory)
  // ---------------------------------------------------------------------------

  private ensureStrategiesLoaded(): void {
    if (this.strategiesLoaded) return;
    this.strategiesLoaded = true;
    const filePath = path.join(this.config.basePath, "scheduling-strategies.json");
    if (!existsSync(filePath)) return;
    const raw = readFileSync(filePath, "utf-8");
    const arr: SchedulingStrategy[] = JSON.parse(raw);
    this.strategies.clear();
    for (const s of arr) {
      // Migration: skip legacy entries without id or backfill missing outcomes
      if (!s.id) continue;
      if (!s.outcomes) {
        s.outcomes = { successes: 0, failures: 0 };
      }
      this.strategies.set(s.id, s);
    }
  }

  private saveStrategies(): void {
    const dirPath = this.config.basePath;
    mkdirSync(dirPath, { recursive: true });
    const filePath = path.join(dirPath, "scheduling-strategies.json");
    const arr = Array.from(this.strategies.values());
    writeFileSync(filePath, JSON.stringify(arr, null, 2), "utf-8");
  }

  /** Persist a new or updated scheduling strategy. */
  saveSchedulingStrategy(strategy: SchedulingStrategy): void {
    this.ensureStrategiesLoaded();
    this.strategies.set(strategy.id, strategy);
    this.saveStrategies();
  }

  /** Load all persisted scheduling strategies. */
  getSchedulingStrategies(): SchedulingStrategy[] {
    this.ensureStrategiesLoaded();
    return Array.from(this.strategies.values());
  }

  /** Update outcome stats for a strategy (running average for tokens). */
  recordStrategyOutcome(id: string, success: boolean, tokensToCompletion?: number): void {
    this.ensureStrategiesLoaded();
    const strategy = this.strategies.get(id);
    if (!strategy) return;

    if (success) {
      strategy.outcomes.successes += 1;
    } else {
      strategy.outcomes.failures += 1;
    }

    if (tokensToCompletion !== undefined) {
      const total = strategy.outcomes.successes + strategy.outcomes.failures;
      const prev = strategy.outcomes.avgTokensToCompletion ?? 0;
      strategy.outcomes.avgTokensToCompletion = prev + (tokensToCompletion - prev) / total;
    }

    strategy.lastUsed = Date.now();
    this.saveStrategies();
  }

  /**
   * Prune low-fitness scheduling strategies.
   * Removes strategies where:
   *   (successes / (successes + failures)) < minFitnessRatio
   *   AND (successes + failures) >= minUses
   * Returns the list of removed strategies.
   */
  pruneStrategies(minUses: number, minFitnessRatio: number): SchedulingStrategy[] {
    this.ensureStrategiesLoaded();
    const removed: SchedulingStrategy[] = [];
    for (const [id, strategy] of this.strategies) {
      const total = strategy.outcomes.successes + strategy.outcomes.failures;
      if (total >= minUses) {
        const fitnessRatio = strategy.outcomes.successes / total;
        if (fitnessRatio < minFitnessRatio) {
          removed.push(strategy);
          this.strategies.delete(id);
        }
      }
    }
    if (removed.length > 0) {
      this.saveStrategies();
    }
    return removed;
  }

  // ---------------------------------------------------------------------------
  // Blueprint Fitness Pruning (GAP 2, R6)
  // ---------------------------------------------------------------------------

  /**
   * Prune low-fitness topology blueprints from the store.
   * A blueprint is pruned if:
   *   stats.uses >= minUses  AND  alpha / (alpha + beta) < minFitnessRatio
   * Seed blueprints (id starts with 'seed-') are never pruned.
   * Saves to disk and returns the count of blueprints pruned.
   */
  pruneBlueprints(minUses: number, minFitnessRatio: number): number {
    const toRemove: string[] = [];
    for (const [id, bp] of this.blueprints) {
      // Never prune seed blueprints
      if (bp.id.startsWith('seed-')) continue;

      const alpha = bp.stats.alpha ?? 1;
      const beta = bp.stats.beta ?? 1;
      const totalUses = bp.stats.uses;
      const fitnessRatio = alpha / (alpha + beta);

      if (totalUses >= minUses && fitnessRatio < minFitnessRatio) {
        toRemove.push(id);
      }
    }

    for (const id of toRemove) {
      this.blueprints.delete(id);
    }

    if (toRemove.length > 0) {
      this.saveBlueprints();
    }

    return toRemove.length;
  }

  // ---------------------------------------------------------------------------
  // Blueprint Task History (Goal Decomposition Learning)
  // ---------------------------------------------------------------------------

  /**
   * Record the outcome of using a blueprint for a particular task class.
   * Persisted in memory.json under blueprintTaskHistory[].
   * At most 500 records are kept (FIFO).
   */
  recordBlueprintTask(record: BlueprintTaskRecord): void {
    this.blueprintTaskHistory.push(record);
    // Cap history to avoid unbounded growth
    if (this.blueprintTaskHistory.length > 500) {
      this.blueprintTaskHistory = this.blueprintTaskHistory.slice(-500);
    }
    this.saveHeuristics();
  }

  /**
   * Recommend the best blueprint for the given task class tags.
   * Queries blueprintTaskHistory for records with overlapping task class tags,
   * computes a weighted success rate per blueprint, and returns the one with
   * the highest weighted success rate.
   *
   * Falls back to the first available blueprint (Bayesian prior selection)
   * if fewer than MIN_HISTORY weighted observations exist for any blueprint.
   *
   * Usage at orchestration time:
   *   const taskClass = extractGoalTags(objective);
   *   const ranked = memoryStore.queryBlueprints(objective);
   *   const best = memoryStore.recommendBlueprint(taskClass, ranked);
   *   // Use `best` as the preferred blueprint, surface it first to the goal-orchestrator
   */
  recommendBlueprint(taskClass: string[], availableBlueprints: TopologyBlueprint[]): TopologyBlueprint {
    if (availableBlueprints.length === 0) {
      throw new Error("availableBlueprints must be non-empty");
    }
    if (taskClass.length === 0 || this.blueprintTaskHistory.length === 0) {
      return availableBlueprints[0]!;
    }

    const MIN_HISTORY = 2; // minimum weighted observations to trust the data

    // Accumulate weighted success stats per blueprint
    const bpStats = new Map<string, { successes: number; attempts: number }>();

    for (const record of this.blueprintTaskHistory) {
      // Jaccard-like overlap: count matching tags
      const overlap = taskClass.filter((t) => record.taskClass.includes(t)).length;
      if (overlap === 0) continue;

      // Weight by overlap ratio (Jaccard-inspired)
      const unionSize = new Set([...taskClass, ...record.taskClass]).size;
      const weight = unionSize > 0 ? overlap / unionSize : 0;
      if (weight === 0) continue;

      const entry = bpStats.get(record.blueprintId) ?? { successes: 0, attempts: 0 };
      entry.attempts += weight;
      entry.successes += record.success ? weight : 0;
      bpStats.set(record.blueprintId, entry);
    }

    // Find the available blueprint with the highest weighted success rate
    let bestBp = availableBlueprints[0]!;
    let bestRate = -1;

    for (const bp of availableBlueprints) {
      const stats = bpStats.get(bp.id);
      if (stats && stats.attempts >= MIN_HISTORY) {
        const rate = stats.successes / stats.attempts;
        if (rate > bestRate) {
          bestRate = rate;
          bestBp = bp;
        }
      }
    }

    return bestBp;
  }

  // ---------------------------------------------------------------------------
  // Auto-Promotion: high-confidence heuristics → SchedulingStrategies
  // ---------------------------------------------------------------------------

  /**
   * Promote heuristics that have reached high confidence and sufficient reinforcement
   * into SchedulingStrategy entries for cross-run scheduler use.
   * Qualifying criteria: confidence >= 0.8 AND reinforcementCount >= 3.
   * Returns the number of heuristics newly promoted this call.
   */
  promoteHeuristics(): number {
    this.ensureStrategiesLoaded();
    let count = 0;

    for (const h of this.heuristics.values()) {
      if (h.supersededBy) continue;
      if (h.confidence < 0.8 || h.reinforcementCount < 3) continue;

      // Skip already-promoted heuristics
      if (this.promotionLog.some((e) => e.heuristicKey === h.id)) continue;

      // Derive priorityBias from content keywords
      const text = h.heuristic.toLowerCase();
      let priorityBias: Record<string, number> | undefined;
      if (text.includes("high priority") || text.includes("higher priority")) {
        priorityBias = { "*": 10 };
      } else if (text.includes("low priority") || text.includes("lower priority")) {
        priorityBias = { "*": -10 };
      }

      // Derive favor patterns from common process name keywords in the heuristic
      const favorKeywords = ["worker", "synthesizer", "orchestrator", "analyzer", "aggregator"];
      const words = text.split(/\s+/);
      const favorPatterns = favorKeywords.filter((kw) => words.some((w) => w.includes(kw)));

      const strategyId = `auto-${Date.now()}-${count}`;
      const strategy: SchedulingStrategy = {
        id: strategyId,
        description: `auto-promoted: ${h.heuristic}`,
        conditions: h.context ? [h.context] : [],
        adjustments: {
          priorityBias,
          favorPatterns,
          disfavorPatterns: [],
        },
        outcomes: { successes: 0, failures: 0 },
        createdAt: Date.now(),
        lastUsed: Date.now(),
      };

      this.strategies.set(strategyId, strategy);

      this.promotionLog.push({
        heuristicKey: h.id,
        heuristicValue: h.heuristic,
        promotedAt: new Date().toISOString(),
        strategyId,
        confidence: h.confidence,
        reinforcementCount: h.reinforcementCount,
      });

      count++;
    }

    if (count > 0) {
      this.saveStrategies();
      this.saveHeuristics(); // persists promotionLog
    }

    return count;
  }

  // ---------------------------------------------------------------------------
  // Kill Calibration Persistence
  // ---------------------------------------------------------------------------

  /**
   * Load kill calibration data from disk.
   * Returns null if file does not exist or cannot be parsed.
   */
  getKillCalibration(): KillCalibrationData | null {
    const filePath = path.join(this.config.basePath, "kill-calibration.json");
    if (!existsSync(filePath)) return null;
    try {
      const raw = readFileSync(filePath, "utf-8");
      return JSON.parse(raw) as KillCalibrationData;
    } catch {
      return null;
    }
  }

  /**
   * Persist kill calibration data to disk.
   */
  setKillCalibration(data: KillCalibrationData): void {
    const dirPath = this.config.basePath;
    mkdirSync(dirPath, { recursive: true });
    const filePath = path.join(dirPath, "kill-calibration.json");
    writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  }

  // ---------------------------------------------------------------------------
  // Checkpoint Persistence (GAP-7)
  // ---------------------------------------------------------------------------

  /**
   * Save a process checkpoint to disk.
   * Path: {basePath}/checkpoints/{runId}/{pid}.json
   */
  saveCheckpoint(checkpoint: OsProcessCheckpoint): void {
    if (!checkpoint.runId) return;
    const dirPath = path.join(this.config.basePath, "checkpoints", checkpoint.runId);
    mkdirSync(dirPath, { recursive: true });
    const filePath = path.join(dirPath, `${checkpoint.pid}.json`);
    writeFileSync(filePath, JSON.stringify(checkpoint, null, 2), "utf-8");
  }

  /**
   * Load a single process checkpoint from disk.
   * Returns null if the checkpoint file does not exist or cannot be parsed.
   */
  loadCheckpoint(runId: string, pid: string): OsProcessCheckpoint | null {
    const filePath = path.join(this.config.basePath, "checkpoints", runId, `${pid}.json`);
    if (!existsSync(filePath)) return null;
    try {
      const raw = readFileSync(filePath, "utf-8");
      return JSON.parse(raw) as OsProcessCheckpoint;
    } catch {
      return null;
    }
  }

  /**
   * Load all checkpoints for a run, sorted newest-first by capturedAt.
   */
  loadCheckpoints(runId: string): OsProcessCheckpoint[] {
    const dirPath = path.join(this.config.basePath, "checkpoints", runId);
    if (!existsSync(dirPath)) return [];

    const files = readdirSync(dirPath).filter((f) => f.endsWith(".json"));
    const checkpoints: OsProcessCheckpoint[] = [];

    for (const file of files) {
      try {
        const raw = readFileSync(path.join(dirPath, file), "utf-8");
        checkpoints.push(JSON.parse(raw) as OsProcessCheckpoint);
      } catch {
        // Skip corrupt checkpoint files
      }
    }

    // Sort newest-first
    checkpoints.sort(
      (a, b) => new Date(b.capturedAt).getTime() - new Date(a.capturedAt).getTime(),
    );
    return checkpoints;
  }

  /**
   * List run IDs that have saved checkpoints.
   */
  listCheckpointRuns(): string[] {
    const dirPath = path.join(this.config.basePath, "checkpoints");
    if (!existsSync(dirPath)) return [];
    try {
      return readdirSync(dirPath).filter((entry) => {
        const entryPath = path.join(dirPath, entry);
        try {
          return statSync(entryPath).isDirectory();
        } catch {
          return false;
        }
      });
    } catch {
      return [];
    }
  }

  /**
   * Remove checkpoints older than maxAgeMs (default 24 hours).
   * Cleans up empty run directories after pruning.
   * Returns the number of checkpoint files removed.
   */
  pruneCheckpoints(maxAgeMs: number = 24 * 60 * 60 * 1000): number {
    const checkpointsDir = path.join(this.config.basePath, "checkpoints");
    if (!existsSync(checkpointsDir)) return 0;

    const cutoff = Date.now() - maxAgeMs;
    let removed = 0;

    for (const runDir of readdirSync(checkpointsDir)) {
      const runPath = path.join(checkpointsDir, runDir);
      try {
        if (!statSync(runPath).isDirectory()) continue;
      } catch {
        continue;
      }

      const files = readdirSync(runPath).filter((f) => f.endsWith(".json"));
      for (const file of files) {
        const filePath = path.join(runPath, file);
        try {
          const raw = readFileSync(filePath, "utf-8");
          const cp = JSON.parse(raw) as OsProcessCheckpoint;
          if (new Date(cp.capturedAt).getTime() < cutoff) {
            unlinkSync(filePath);
            removed++;
          }
        } catch {
          // Remove corrupt files too
          try { unlinkSync(filePath); removed++; } catch { /* ignore */ }
        }
      }

      // Clean up empty directories
      try {
        const remaining = readdirSync(runPath);
        if (remaining.length === 0) {
          rmSync(runPath, { recursive: true });
        }
      } catch { /* ignore */ }
    }

    return removed;
  }

  // ---------------------------------------------------------------------------
  // Batch Reinforcement
  // ---------------------------------------------------------------------------

  /**
   * Reinforce multiple heuristics by ID. Silently skips missing IDs.
   * Returns the count of heuristics actually reinforced.
   * Saves heuristics to disk after batch update.
   */
  reinforceBatch(heuristicIds: string[]): number {
    let count = 0;
    for (const id of heuristicIds) {
      const h = this.heuristics.get(id);
      if (!h) continue;
      h.reinforcementCount += 1;
      h.reinforcedAt = new Date().toISOString();
      const boost = this.config.heuristicDecayRate * 2 / (1 + h.reinforcementCount * 0.1);
      h.confidence = Math.min(1, Math.max(0.1, h.confidence + boost));
      count++;
    }
    if (count > 0) {
      this.saveHeuristics();
    }
    return count;
  }

  /**
   * Penalize multiple heuristics by ID. Silently skips missing IDs.
   * Applies a confidence reduction (half the decay rate) — enough to counteract
   * a spurious reinforcement, not enough to kill a heuristic after one bad outcome.
   * Returns the count of heuristics actually penalized.
   * Saves heuristics to disk after batch update.
   */
  penalizeBatch(heuristicIds: string[]): number {
    let count = 0;
    const penalty = this.config.heuristicDecayRate * 0.5;
    for (const id of heuristicIds) {
      const h = this.heuristics.get(id);
      if (!h) continue;
      h.confidence = Math.max(0, h.confidence - penalty);
      count++;
    }
    if (count > 0) {
      this.saveHeuristics();
    }
    return count;
  }

  /**
   * Perform end-of-run cleanup: promote qualifying heuristics to strategies,
   * then prune low-fitness strategies.
   * Prune criteria: used >= 3 times AND fitness ratio < 30%.
   */
  shutdown(): void {
    this.promoteHeuristics();
    // Prune strategies that have been tried enough times but consistently fail
    this.pruneStrategies(3, 0.3);
  }

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  clearHeuristics(): void {
    this.heuristics.clear();
    const filePath = path.join(this.config.basePath, "memory.json");
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  }

  get heuristicCount(): number {
    return this.heuristics.size;
  }

  // ---------------------------------------------------------------------------
  // Consolidation Markers
  // ---------------------------------------------------------------------------

  /**
   * Check whether any heuristics have been learned since the last consolidation.
   * Returns true if there's new episodic data worth consolidating.
   */
  hasNewEpisodicData(): boolean {
    const markerPath = path.join(this.config.basePath, "last-consolidation.json");
    let lastConsolidationTime = 0;
    try {
      const data = JSON.parse(readFileSync(markerPath, "utf-8"));
      lastConsolidationTime = data.timestamp ?? 0;
    } catch {
      // No marker file = never consolidated = has new data if any heuristics exist
      return this.heuristics.size > 0;
    }

    for (const h of this.heuristics.values()) {
      const learnedAt = h.learnedAt ? new Date(h.learnedAt).getTime() : 0;
      if (learnedAt > lastConsolidationTime) return true;
    }
    return false;
  }

  /**
   * Mark the current time as the last consolidation point.
   * Called at shutdown after heuristics are saved.
   */
  markConsolidated(): void {
    mkdirSync(this.config.basePath, { recursive: true });
    const markerPath = path.join(this.config.basePath, "last-consolidation.json");
    writeFileSync(markerPath, JSON.stringify({ timestamp: Date.now() }));
  }
}
