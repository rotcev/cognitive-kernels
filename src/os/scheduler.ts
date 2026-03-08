import type {
  OsProcess,
  OsProcessState,
  OsSchedulerStrategy,
  OsSchedulerConfig,
  OsDagTopology,
  OsHeuristic,
  SchedulingStrategy,
} from "./types.js";

export class OsScheduler {
  public tickCount: number = 0;
  private strategy: OsSchedulerStrategy;
  private maxConcurrent: number;
  private roundRobinIndex: number = 0;
  private heuristics: OsHeuristic[] = [];
  private currentStrategies: SchedulingStrategy[] = [];

  constructor(config: OsSchedulerConfig) {
    this.strategy = config.strategy;
    this.maxConcurrent = config.maxConcurrentProcesses;
  }

  /** Expose round-robin index for state extraction (Wave 4). */
  getRoundRobinIndex(): number {
    return this.roundRobinIndex;
  }

  /** Expose current strategies for state extraction (Wave 4). */
  getCurrentStrategies(): SchedulingStrategy[] {
    return this.currentStrategies;
  }

  /** Set round-robin index from state sync (Wave 4). */
  setRoundRobinIndex(index: number): void {
    this.roundRobinIndex = index;
  }

  /** Inject learned heuristics for the "learned" scheduling strategy. */
  setHeuristics(heuristics: OsHeuristic[]): void {
    this.heuristics = heuristics;
  }

  /** Apply scheduling strategies derived from cross-run memory. */
  applyStrategies(strategies: SchedulingStrategy[]): void {
    // Future: use strategy action field to modify scheduling weights
    // For now: log and store for introspection
    this.currentStrategies = strategies;
  }

  tick(): number {
    this.tickCount += 1;
    return this.tickCount;
  }

  selectRunnable(processes: OsProcess[], topology?: OsDagTopology): OsProcess[] {
    const runnable = processes.filter((p) => p.state === "running");

    if (runnable.length === 0) {
      return [];
    }

    let selected: OsProcess[];

    switch (this.strategy) {
      case "priority": {
        const sorted = [...runnable].sort((a, b) => b.priority - a.priority);
        selected = sorted.slice(0, this.maxConcurrent);
        break;
      }

      case "learned": {
        selected = this.learnedSelect(runnable, processes, topology);
        break;
      }

      case "round-robin": {
        selected = [];
        const count = Math.min(this.maxConcurrent, runnable.length);
        for (let i = 0; i < count; i++) {
          const index = (this.roundRobinIndex + i) % runnable.length;
          selected.push(runnable[index]);
        }
        this.roundRobinIndex = (this.roundRobinIndex + count) % runnable.length;
        break;
      }

      case "deadline": {
        const sorted = [...runnable].sort((a, b) => {
          const aDeadline = a.sleepUntil ?? "";
          const bDeadline = b.sleepUntil ?? "";
          // Handle both numeric and ISO string deadlines
          const aNum = typeof aDeadline === "number" ? aDeadline : (aDeadline ? new Date(aDeadline).getTime() : Number.MAX_SAFE_INTEGER);
          const bNum = typeof bDeadline === "number" ? bDeadline : (bDeadline ? new Date(bDeadline).getTime() : Number.MAX_SAFE_INTEGER);
          return aNum - bNum;
        });
        selected = sorted.slice(0, this.maxConcurrent);
        break;
      }

      default: {
        const _exhaustive: never = this.strategy;
        selected = runnable.slice(0, this.maxConcurrent);
        break;
      }
    }

    return selected;
  }

  /**
   * Learned scheduling strategy. Applies heuristic-derived rules:
   *
   * 1. Sibling priority gradient — when siblings share the same priority,
   *    apply a 2-point gradient to prevent contention (heuristics S-001, S-002).
   * 2. Synthesis deprioritization — processes whose names contain "synth" or
   *    that are orchestrators past tick 0 get deprioritized below workers,
   *    so they only run after dependencies complete (heuristic G-004).
   * 3. Liveness boost — processes with recent token progress get a slight
   *    priority bump over stalled ones (heuristic L-001).
   */
  private learnedSelect(
    runnable: OsProcess[],
    allProcesses: OsProcess[],
    topology?: OsDagTopology,
  ): OsProcess[] {
    // Build effective priorities by applying learned adjustments
    const effectivePriority = new Map<string, number>();
    for (const proc of runnable) {
      effectivePriority.set(proc.pid, proc.priority);
    }

    // Rule 1: Sibling contention prevention (S-001, S-002)
    // Group runnable processes by parent, detect equal-priority siblings,
    // apply 2-point gradient so they don't all compete for the same slot.
    const siblingGroups = new Map<string, OsProcess[]>();
    for (const proc of runnable) {
      const parent = proc.parentPid ?? "__root__";
      const group = siblingGroups.get(parent) ?? [];
      group.push(proc);
      siblingGroups.set(parent, group);
    }

    for (const [, siblings] of siblingGroups) {
      if (siblings.length < 2) continue;

      // Check if siblings share the same priority (contention risk)
      const priorities = new Set(siblings.map((s) => s.priority));
      if (priorities.size === 1) {
        // Apply graduated 2-point gradient: first sibling keeps priority,
        // each subsequent one gets -2 points
        const sorted = [...siblings].sort(
          (a, b) => a.spawnedAt.localeCompare(b.spawnedAt),
        );
        for (let i = 0; i < sorted.length; i++) {
          const base = effectivePriority.get(sorted[i]!.pid)!;
          effectivePriority.set(sorted[i]!.pid, base - i * 2);
        }
      }
    }

    // Rule 2: Synthesis deprioritization (G-004)
    // Synthesis/orchestrator processes should run after workers finish.
    for (const proc of runnable) {
      const isSynthesis =
        proc.name.includes("synth") ||
        proc.name.includes("consolidat") ||
        (proc.name === "goal-orchestrator" && proc.tickCount > 0);

      if (isSynthesis) {
        // Find the minimum worker priority in this group
        const siblings = allProcesses.filter(
          (p) =>
            p.parentPid === proc.parentPid &&
            p.pid !== proc.pid &&
            p.state !== "dead",
        );
        if (siblings.length > 0) {
          const minWorkerPriority = Math.min(
            ...siblings.map((s) => effectivePriority.get(s.pid) ?? s.priority),
          );
          const current = effectivePriority.get(proc.pid)!;
          // Ensure synthesis runs below its dependencies
          if (current >= minWorkerPriority) {
            effectivePriority.set(proc.pid, minWorkerPriority - 5);
          }
        }
      }
    }

    // Rule 3: Liveness boost (L-001)
    // Processes showing token progress get a slight bump over stalled ones.
    for (const proc of runnable) {
      if (proc.tickCount > 0 && proc.tokensUsed > 0) {
        const tokensPerTick = proc.tokensUsed / proc.tickCount;
        if (tokensPerTick > 50) {
          // Active progress — small boost
          const current = effectivePriority.get(proc.pid)!;
          effectivePriority.set(proc.pid, current + 1);
        }
      }
    }

    // Phase 4: Heuristic-driven scoring (closes the learning feedback loop).
    // Reads this.heuristics — previously unused — and applies keyword-matched
    // scoring adjustments on top of Rules 1–3. When no heuristics are loaded
    // this phase is a no-op, so existing behavior is fully preserved.
    if (this.heuristics.length > 0) {
      const scores = new Map<string, number>();
      for (const proc of runnable) {
        scores.set(proc.pid, 0);
      }

      for (const h of this.heuristics) {
        const text = h.heuristic.toLowerCase();

        // Synthesis signal: deprioritize aggregating / fan-in processes so
        // they run after the workers that feed them.
        if (
          text.includes("synthesis") ||
          text.includes("aggregat") ||
          text.includes("consolidat") ||
          text.includes("fan-in")
        ) {
          for (const proc of runnable) {
            const nameLower = proc.name.toLowerCase();
            const objLower = proc.objective.toLowerCase();
            const isSynthesisLike =
              nameLower.includes("synthesis") ||
              nameLower.includes("aggregat") ||
              nameLower.includes("consolidat") ||
              nameLower.includes("fan-in") ||
              objLower.includes("synthesis") ||
              objLower.includes("aggregat") ||
              objLower.includes("consolidat") ||
              objLower.includes("fan-in");
            if (isSynthesisLike) {
              scores.set(proc.pid, (scores.get(proc.pid) ?? 0) - 5);
            }
          }
        }

        // Flat-priority / contention signal: when two or more candidates share
        // the same effective priority, penalise all but the winner (-3 each).
        // Winner = highest raw priority; tiebreak = first alphabetically by name.
        if (
          text.includes("flat-priority") ||
          text.includes("gradient") ||
          text.includes("contention") ||
          text.includes("sibling")
        ) {
          const byEffPriority = new Map<number, OsProcess[]>();
          for (const proc of runnable) {
            const ep = effectivePriority.get(proc.pid) ?? proc.priority;
            const group = byEffPriority.get(ep) ?? [];
            group.push(proc);
            byEffPriority.set(ep, group);
          }
          for (const [, group] of byEffPriority) {
            if (group.length < 2) continue;
            // Highest raw priority wins; ties broken alphabetically by name.
            const winner = group.reduce((best, cur) => {
              if (cur.priority > best.priority) return cur;
              if (cur.priority === best.priority && cur.name < best.name) return cur;
              return best;
            });
            for (const proc of group) {
              if (proc.pid !== winner.pid) {
                scores.set(proc.pid, (scores.get(proc.pid) ?? 0) - 3);
              }
            }
          }
        }

        // Liveness / watchdog signal: boost processes that have consumed tokens,
        // indicating they are making real progress.
        if (
          text.includes("liveness") ||
          text.includes("watchdog") ||
          text.includes("token")
        ) {
          for (const proc of runnable) {
            if (proc.tokensUsed > 0) {
              scores.set(proc.pid, (scores.get(proc.pid) ?? 0) + 2);
            }
          }
        }
      }

      // Apply accumulated heuristic scores to effective priorities.
      for (const [pid, score] of scores) {
        if (score !== 0) {
          const current = effectivePriority.get(pid) ?? 0;
          effectivePriority.set(pid, current + score);
        }
      }
    }

    // Rule 5: Apply SchedulingStrategy adjustments from cross-run memory.
    // currentStrategies are pre-filtered by the kernel (via getBestStrategies)
    // before being passed to applyStrategies(), so they are already relevant to
    // current conditions. Applying their adjustments here closes the
    // record_strategy → scheduling feedback loop that was previously broken
    // (strategies were saved to disk but never applied at runtime).
    if (this.currentStrategies.length > 0) {
      for (const proc of runnable) {
        const nameLower = proc.name.toLowerCase();
        let strategyDelta = 0;

        for (const strategy of this.currentStrategies) {
          const { adjustments } = strategy;

          // priorityBias: process name pattern → priority delta
          if (adjustments.priorityBias) {
            for (const [pattern, delta] of Object.entries(adjustments.priorityBias)) {
              if (nameLower.includes(pattern.toLowerCase())) {
                strategyDelta += delta;
              }
            }
          }

          // disfavorPatterns: apply a -5 penalty to matching processes
          if (adjustments.disfavorPatterns) {
            for (const pattern of adjustments.disfavorPatterns) {
              if (nameLower.includes(pattern.toLowerCase())) {
                strategyDelta -= 5;
              }
            }
          }

          // favorPatterns: apply a +5 bonus to matching processes
          if (adjustments.favorPatterns) {
            for (const pattern of adjustments.favorPatterns) {
              if (nameLower.includes(pattern.toLowerCase())) {
                strategyDelta += 5;
              }
            }
          }
        }

        if (strategyDelta !== 0) {
          const current = effectivePriority.get(proc.pid) ?? proc.priority;
          effectivePriority.set(proc.pid, current + strategyDelta);
        }
      }
    }

    // Sort by effective priority and select
    const sorted = [...runnable].sort((a, b) => {
      const aPri = effectivePriority.get(a.pid) ?? a.priority;
      const bPri = effectivePriority.get(b.pid) ?? b.priority;
      return bPri - aPri;
    });

    return sorted.slice(0, this.maxConcurrent);
  }

  shouldConsultMetacog(metacogCadence: number): boolean {
    return this.tickCount % metacogCadence === 0 && this.tickCount > 0;
  }

  reset(): void {
    this.tickCount = 0;
    this.roundRobinIndex = 0;
    this.heuristics = [];
  }
}
