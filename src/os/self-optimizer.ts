import type { MetacogCommand, OsDagPatch } from './types.js';
import type { TelemetrySnapshot } from './types.js';
import type { Recommendation, BottleneckReport } from './perf-analyzer.js';

// ─── Public Types ────────────────────────────────────────────────

export interface ExplorationBudget {
  totalTokenBudget: number;
  usedTokens: number;
  remainingTokens: number;
  /** True when remaining > 30% of total AND unresolved bottlenecks exist. */
  shouldFork: boolean;
  /** True when remaining < 20% of total — commit to current path. */
  shouldCommit: boolean;
}

export interface TopologyMutation {
  /** Description of the observed bottleneck pattern driving this mutation. */
  sourcePattern: string;
  /** Blueprint name or 'novel:<name>' when inventing a new topology. */
  proposedBlueprint: string;
  mutations: {
    namePrefix?: string;
    roleChanges?: string[];
    gatingChange?: string;
    channelChanges?: string[];
  };
  rationale: string;
}

export interface StrategyRecord {
  blueprintId: string;
  outcome: 'success' | 'failure' | 'partial';
  tokensUsed: number;
  wallTimeMs: number;
  bottlenecksResolved: string[];
  /** Human-readable lesson distilled from this run. */
  heuristic: string;
}

// ─── Thresholds ──────────────────────────────────────────────────

/** Remaining token fraction above which forking is viable. */
const FORK_BUDGET_THRESHOLD = 0.30;

/** Remaining token fraction below which the system should commit. */
const COMMIT_BUDGET_THRESHOLD = 0.20;

// ─── SelfOptimizer ───────────────────────────────────────────────

/**
 * Takes PerfAnalyzer recommendations and generates concrete MetacogCommands.
 * Also provides exploration budget assessment and topology mutation planning.
 */
export class SelfOptimizer {
  private readonly strategies: StrategyRecord[] = [];

  constructor(
    private readonly recommendations: Recommendation[],
    private readonly snapshot: TelemetrySnapshot,
    private readonly tokenBudget: number,
  ) {}

  /**
   * Translates all recommendations into executable MetacogCommands.
   * Recommendations that map to unsupported or structurally-incomplete
   * command kinds are silently filtered out.
   */
  optimize(): MetacogCommand[] {
    return this.recommendations
      .map((rec) => this.recommendationToCommand(rec))
      .filter((cmd): cmd is MetacogCommand => cmd !== null);
  }

  /**
   * Evaluates remaining token budget to decide whether to fork new
   * explorations or commit to the current execution path.
   */
  assessExplorationBudget(): ExplorationBudget {
    const usedTokens = this.computeUsedTokens();
    const remainingTokens = Math.max(0, this.tokenBudget - usedTokens);
    const remainingRatio =
      this.tokenBudget > 0 ? remainingTokens / this.tokenBudget : 0;
    const hasUnresolvedBottlenecks = this.recommendations.length > 0;

    return {
      totalTokenBudget: this.tokenBudget,
      usedTokens,
      remainingTokens,
      shouldFork: remainingRatio > FORK_BUDGET_THRESHOLD && hasUnresolvedBottlenecks,
      shouldCommit: remainingRatio < COMMIT_BUDGET_THRESHOLD,
    };
  }

  /**
   * Proposes concrete topology mutations for each class of bottleneck
   * found in the report. Mutations are expressed as blueprint evolutions
   * the metacog kernel can apply via `evolve_blueprint`.
   */
  planTopologyMutation(bottleneck: BottleneckReport): TopologyMutation[] {
    const mutations: TopologyMutation[] = [];

    if (bottleneck.highTokensPerOutputLine.length > 0) {
      mutations.push({
        sourcePattern: 'high_tokens_per_output_line',
        proposedBlueprint: 'fan-out-fan-in',
        mutations: {
          namePrefix: 'token-efficient-',
          roleChanges: [
            'split heavy worker into N parallel workers with smaller objectives',
          ],
          gatingChange: 'signal-gate',
        },
        rationale:
          `${bottleneck.highTokensPerOutputLine.length} process(es) have high ` +
          `token/line ratio. Fan-out splits work into smaller parallel workers, ` +
          `reducing per-worker token overhead.`,
      });
    }

    if (bottleneck.convoyEffects.length > 0) {
      mutations.push({
        sourcePattern: 'convoy_effect',
        proposedBlueprint: 'pipeline',
        mutations: {
          namePrefix: 'interleaved-',
          gatingChange: 'idle-gate',
          channelChanges: bottleneck.convoyEffects.flatMap((c) =>
            c.pids.map((pid, i) => `${pid}→stage-${i + 1}`),
          ),
        },
        rationale:
          `Convoy effect: ${bottleneck.convoyEffects.length} cluster(s) detected. ` +
          `A pipeline topology interleaves execution and reduces head-of-line blocking.`,
      });
    }

    if (bottleneck.starvationRisk.length > 0) {
      mutations.push({
        sourcePattern: 'starvation',
        proposedBlueprint: 'parallel',
        mutations: {
          namePrefix: 'gradient-priority-',
          roleChanges: ['apply 2-point priority gradient across all siblings'],
        },
        rationale:
          `${bottleneck.starvationRisk.length} process(es) at starvation risk. ` +
          `Parallel topology with gradient priorities ensures all processes get scheduled.`,
      });
    }

    if (bottleneck.priorityInversions.length > 0) {
      mutations.push({
        sourcePattern: 'priority_inversion',
        proposedBlueprint: 'pipeline',
        mutations: {
          gatingChange: 'priority-only',
          roleChanges: ['reassign priorities to enforce strict execution ordering'],
        },
        rationale:
          `${bottleneck.priorityInversions.length} priority inversion(s) detected. ` +
          `Restructuring as pipeline enforces ordering without relying on scheduler priority.`,
      });
    }

    return mutations;
  }

  /**
   * Records a strategy outcome for cross-run learning.
   * Strategies are kept in-memory; the kernel flushes them to the memory store.
   */
  recordStrategy(record: StrategyRecord): void {
    this.strategies.push(record);
  }

  /** Returns a snapshot of all recorded strategies. */
  getStrategyHistory(): StrategyRecord[] {
    return [...this.strategies];
  }

  // ── Private Helpers ──────────────────────────────────────────────

  /**
   * Maps a single Recommendation to a concrete MetacogCommand.
   * Returns null for unsupported or structurally-incomplete recommendations.
   */
  private recommendationToCommand(rec: Recommendation): MetacogCommand | null {
    switch (rec.kind) {
      case 'reprioritize': {
        if (!rec.targetPid) return null;
        const newPriority = rec.payload['newPriority'];
        if (typeof newPriority !== 'number') return null;
        return { kind: 'reprioritize', pid: rec.targetPid, priority: newPriority };
      }

      case 'spawn': {
        const channel = rec.payload['channel'];
        const purpose = rec.payload['purpose'];
        return {
          kind: 'spawn',
          descriptor: {
            type: 'lifecycle',
            name:
              typeof channel === 'string'
                ? `drain-${channel}`
                : 'spawned-worker',
            objective:
              typeof purpose === 'string' ? purpose : rec.rationale,
            priority: 50,
          },
        };
      }

      case 'kill': {
        if (!rec.targetPid) return null;
        return {
          kind: 'kill',
          pid: rec.targetPid,
          cascade: false,
          reason: rec.rationale,
        };
      }

      case 'rewrite_dag': {
        // GAP 3 (R6): rewrite_dag now requires a DagMutation discriminated union.
        // SelfOptimizer lacks the process-table context to select the right mutation type;
        // defer topology rewrites to the LLM metacog agent which can reason about structure.
        return null;
      }

      // The following kinds are issued by the metacog kernel directly; the
      // SelfOptimizer does not synthesize them from PerfAnalyzer output.
      case 'learn':
      case 'halt':
      case 'define_blueprint':
      case 'fork':
      case 'evolve_blueprint':
      case 'record_strategy':
      case 'noop':
      case 'delegate_evaluation':
        return null;
    }
    return null;
  }

  /** Sums tokensUsed across all ProcessMetrics entries in the snapshot. */
  private computeUsedTokens(): number {
    return Object.values(this.snapshot.processMetrics).reduce(
      (sum, m) => sum + m.tokensUsed,
      0,
    );
  }
}
