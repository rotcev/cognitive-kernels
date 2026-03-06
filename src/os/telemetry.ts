import type {
  OsSystemSnapshot,
  OsEphemeralResult,
  ProcessMetrics,
  CheckpointMetrics,
  ForkDivergence,
  TelemetrySnapshot,
} from "./types.js";

export class TelemetryCollector {
  private processMetrics: Record<string, ProcessMetrics> = {};
  private checkpointMetrics: Record<string, CheckpointMetrics> = {};
  private forkDivergence: ForkDivergence[] = [];
  private blueprintUsage: Record<string, { count: number; avgGoalComplexity: number }> = {};

  // Ephemeral process counters
  ephemeralSpawns = 0;
  ephemeralSuccesses = 0;
  ephemeralFailures = 0;
  ephemeralTotalDurationMs = 0;

  /**
   * Called on each kernel tick with the current OS snapshot.
   * Updates per-process metrics — tokens, first-activation time, scheduling wait.
   */
  onTick(snapshot: OsSystemSnapshot): void {
    for (const proc of snapshot.processes) {
      const createdAt = new Date(proc.spawnedAt).getTime();
      const existing = this.processMetrics[proc.pid];

      if (!existing) {
        // First time we see this process — initialise its metrics entry.
        const firstActivatedAt = proc.state === "running" ? Date.now() : null;
        const schedulingWaitMs =
          firstActivatedAt !== null ? firstActivatedAt - createdAt : 0;

        this.processMetrics[proc.pid] = {
          pid: proc.pid,
          name: proc.name,
          tokensUsed: proc.tokensUsed,
          outputLineCount: 0,
          tokensPerOutputLine: 0,
          schedulingWaitMs,
          createdAt,
          firstActivatedAt,
          completedAt: null,
          priority: proc.priority,
        };
      } else {
        // Update token count from the snapshot (kernel keeps it authoritative).
        existing.tokensUsed = proc.tokensUsed;
        // Keep name up-to-date in case it changes (rare but possible).
        if (!existing.name) existing.name = proc.name;
        // Update priority (may change via reprioritize metacog command).
        existing.priority = proc.priority;

        // If the process just became running for the first time, record the timestamp.
        if (proc.state === "running" && existing.firstActivatedAt === null) {
          const now = Date.now();
          existing.firstActivatedAt = now;
          existing.schedulingWaitMs = now - existing.createdAt;
        }
      }
    }
  }

  /**
   * Called when a process finishes executing its turn with known token and output data.
   * Updates tokensUsed, outputLineCount, tokensPerOutputLine, and completedAt.
   */
  onProcessComplete(pid: string, tokensUsed: number, outputLines: string[]): void {
    let metrics = this.processMetrics[pid];
    if (!metrics) {
      // Guard: create a placeholder if onTick hasn't run yet for this pid.
      metrics = {
        pid,
        tokensUsed: 0,
        outputLineCount: 0,
        tokensPerOutputLine: 0,
        schedulingWaitMs: 0,
        createdAt: Date.now(),
        firstActivatedAt: null,
        completedAt: null,
      };
      this.processMetrics[pid] = metrics;
    }

    const outputLineCount = outputLines.filter((l) => l.trim().length > 0).length;

    metrics.tokensUsed = tokensUsed;
    metrics.outputLineCount = outputLineCount;
    metrics.completedAt = Date.now();
    metrics.tokensPerOutputLine = tokensUsed / Math.max(1, outputLineCount);
  }

  /**
   * Called when a process is forked.
   * Records a ForkDivergence entry, computing a divergence score via character-level LCS
   * if both parent and child outputs are provided.
   */
  onFork(
    parentPid: string,
    childPid: string,
    parentOutput?: string,
    childOutput?: string,
  ): void {
    let divergenceScore = 0;

    if (parentOutput !== undefined && childOutput !== undefined) {
      const lcsLen = this.lcs(parentOutput, childOutput);
      divergenceScore =
        1 -
        lcsLen / Math.max(1, Math.max(parentOutput.length, childOutput.length));
    }

    this.forkDivergence.push({ parentPid, childPid, divergenceScore });
  }

  /**
   * Called when a blueprint is selected for a goal.
   * Maintains a running average of goal complexity per blueprint.
   */
  onBlueprintSelected(blueprintId: string, goalComplexity: number): void {
    const existing = this.blueprintUsage[blueprintId];
    if (!existing) {
      this.blueprintUsage[blueprintId] = {
        count: 1,
        avgGoalComplexity: goalComplexity,
      };
    } else {
      const newCount = existing.count + 1;
      existing.avgGoalComplexity =
        (existing.avgGoalComplexity * existing.count + goalComplexity) / newCount;
      existing.count = newCount;
    }
  }

  /**
   * Called when an ephemeral process completes (success or failure).
   * Updates ephemeral counters for metacog visibility.
   */
  onEphemeralComplete(result: OsEphemeralResult): void {
    this.ephemeralSpawns++;
    this.ephemeralTotalDurationMs += result.durationMs;
    if (result.success) {
      this.ephemeralSuccesses++;
    } else {
      this.ephemeralFailures++;
    }
  }

  /**
   * Returns a deep copy of the current telemetry state.
   */
  getSnapshot(): TelemetrySnapshot {
    return JSON.parse(
      JSON.stringify({
        timestamp: Date.now(),
        processMetrics: this.processMetrics,
        checkpointMetrics: this.checkpointMetrics,
        forkDivergence: this.forkDivergence,
        blueprintUsage: this.blueprintUsage,
      }),
    ) as TelemetrySnapshot;
  }

  /**
   * Resets all internal state to empty. Useful between runs.
   */
  reset(): void {
    this.processMetrics = {};
    this.checkpointMetrics = {};
    this.forkDivergence = [];
    this.blueprintUsage = {};
    this.ephemeralSpawns = 0;
    this.ephemeralSuccesses = 0;
    this.ephemeralFailures = 0;
    this.ephemeralTotalDurationMs = 0;
  }

  /**
   * Computes the Longest Common Subsequence length between two strings.
   * Truncates both inputs to 500 characters to avoid O(n²) blowup on large strings.
   */
  private lcs(a: string, b: string): number {
    const s1 = a.slice(0, 500);
    const s2 = b.slice(0, 500);
    const m = s1.length;
    const n = s2.length;

    // Use two-row DP for O(n) space.
    const prev = new Array<number>(n + 1).fill(0);
    const curr = new Array<number>(n + 1).fill(0);

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (s1[i - 1] === s2[j - 1]) {
          curr[j] = (prev[j - 1] ?? 0) + 1;
        } else {
          curr[j] = Math.max(prev[j] ?? 0, curr[j - 1] ?? 0);
        }
      }
      // Rotate rows.
      for (let j = 0; j <= n; j++) {
        prev[j] = curr[j] ?? 0;
        curr[j] = 0;
      }
    }

    return prev[n] ?? 0;
  }
}
