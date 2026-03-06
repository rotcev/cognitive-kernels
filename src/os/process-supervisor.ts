import type {
  OsProcess,
  OsProcessDescriptor,
  OsProcessCheckpoint,
  OsProcessEvent,
  OsProcessState,
  OsProcessesConfig,
} from "./types.js";
import { OsProcessTable } from "./process-table.js";

export class OsProcessSupervisor {
  private readonly table: OsProcessTable;
  private readonly config: OsProcessesConfig;

  constructor(table: OsProcessTable, config: OsProcessesConfig) {
    this.table = table;
    this.config = config;
  }

  /** Spawn a new process in the "spawned" state. */
  spawn(descriptor: OsProcessDescriptor): OsProcess {
    if (this.table.size >= this.config.maxTotalProcesses) {
      throw new Error(
        `Maximum total processes reached (${this.config.maxTotalProcesses})`
      );
    }

    const depth = this.getProcessDepth(descriptor.parentPid ?? null);
    if (depth >= this.config.maxDepth) {
      throw new Error(
        `Maximum process depth reached (${this.config.maxDepth})`
      );
    }

    return this.table.spawn({
      ...descriptor,
      priority: descriptor.priority ?? this.config.defaultPriority,
    });
  }

  /** Fork: spawn a child that inherits parent context. */
  fork(parentPid: string, objective: string, name?: string): OsProcess {
    const parent = this.table.get(parentPid);
    if (!parent) {
      throw new Error(`Parent process not found: ${parentPid}`);
    }

    const forkedProcess = this.spawn({
      type: parent.type,
      name: name ?? `${parent.name}-fork`,
      objective,
      priority: parent.priority,
      model: parent.model,
      workingDir: parent.workingDir,
      parentPid,
      onParentDeath: parent.onParentDeath,
      restartPolicy: parent.restartPolicy,
      tokenBudget: parent.tokenBudget,
    });

    if (parent.checkpoint) {
      forkedProcess.checkpoint = JSON.parse(JSON.stringify(parent.checkpoint));
    }

    return forkedProcess;
  }

  /** Transition a process to "running". Idempotent — returns as-is if already running. */
  activate(pid: string): OsProcess {
    const proc = this.table.get(pid);
    if (!proc) throw new Error(`Process not found: ${pid}`);
    if (proc.state === "running") return proc;
    return this.table.transitionState(pid, "running");
  }

  /** Suspend a running process. */
  suspend(pid: string): OsProcess {
    return this.table.transitionState(pid, "suspended");
  }

  /** Resume a suspended process. */
  resume(pid: string): OsProcess {
    return this.table.transitionState(pid, "running");
  }

  /** Put a process to sleep with a timer. */
  sleep(pid: string, durationMs: number): OsProcess {
    const proc = this.table.get(pid);
    if (!proc) throw new Error(`Process not found: ${pid}`);

    const updated = this.table.transitionState(pid, "sleeping");
    updated.sleepUntil = new Date(Date.now() + durationMs).toISOString();
    return updated;
  }

  /** Put a process into idle state waiting for wake conditions. */
  idle(
    pid: string,
    wakeConditions: { signals?: string[] }
  ): OsProcess {
    const proc = this.table.get(pid);
    if (!proc) throw new Error(`Process not found: ${pid}`);

    const updated = this.table.transitionState(pid, "idle");
    if (wakeConditions.signals) {
      updated.wakeOnSignals = wakeConditions.signals;
    }
    return updated;
  }

  /** Kill a process (optionally cascade to children). */
  kill(pid: string, cascade = false, reason = "killed"): string[] {
    return this.table.kill(pid, cascade, reason);
  }

  /** Checkpoint a process — capture its state. */
  checkpoint(
    pid: string,
    conversationSummary: string,
    pendingObjectives: string[],
    artifacts: Record<string, string> = {}
  ): OsProcessCheckpoint {
    const proc = this.table.get(pid);
    if (!proc) throw new Error(`Process not found: ${pid}`);

    const previousState = proc.state;
    this.table.transitionState(pid, "checkpoint");

    const cp: OsProcessCheckpoint = {
      pid,
      capturedAt: new Date().toISOString(),
      conversationSummary,
      pendingObjectives,
      artifacts,
    };

    proc.checkpoint = cp;

    this.table.emitEvent({
      kind: "checkpoint_created",
      pid,
      timestamp: cp.capturedAt,
      details: { previousState },
    });

    return cp;
  }

  /** Restore a process from a checkpoint. Uses checkpoint metadata when available. */
  restore(checkpoint: OsProcessCheckpoint, model?: string, workingDir?: string): OsProcess {
    const proc = this.table.get(checkpoint.pid);
    if (proc && proc.state !== "dead") {
      throw new Error(
        `Cannot restore: process ${checkpoint.pid} still exists in state ${proc.state}`
      );
    }

    // Spawn a new process with checkpoint context — use checkpoint metadata when available
    const restored = this.table.spawn({
      type: checkpoint.processType ?? "lifecycle",
      name: checkpoint.processName ? `restored-${checkpoint.processName}` : `restored-${checkpoint.pid}`,
      objective: checkpoint.processObjective ?? (checkpoint.pendingObjectives.join("; ") || "Restored from checkpoint"),
      priority: checkpoint.processPriority,
      model: model ?? checkpoint.processModel,
      workingDir: workingDir ?? checkpoint.processWorkingDir,
      backend: checkpoint.backend,
    });

    // Restored processes are orphans — original parent context no longer exists
    restored.checkpoint = checkpoint;

    this.table.emitEvent({
      kind: "checkpoint_restored",
      pid: restored.pid,
      timestamp: new Date().toISOString(),
      details: {
        originalPid: checkpoint.pid,
        originalRunId: checkpoint.runId,
        tickCount: checkpoint.tickCount,
      },
    });

    return restored;
  }

  /** Wake all sleeping processes whose timers have expired. */
  wakeExpiredSleepers(): string[] {
    const now = new Date().toISOString();
    const woken: string[] = [];

    for (const proc of this.table.getByState("sleeping")) {
      if (proc.sleepUntil && proc.sleepUntil <= now) {
        this.table.transitionState(proc.pid, "running");
        proc.sleepUntil = undefined;
        woken.push(proc.pid);
      }
    }

    return woken;
  }

  /** Wake idle processes that match given signals. */
  wakeOnCondition(signals: string[]): string[] {
    const woken: string[] = [];

    for (const proc of this.table.getByState("idle")) {
      let shouldWake = false;

      if (proc.wakeOnSignals?.length) {
        for (const pattern of proc.wakeOnSignals) {
          if (signals.some((s) => s === pattern || matchGlob(pattern, s))) {
            shouldWake = true;
            break;
          }
        }
      }

      if (shouldWake) {
        this.table.transitionState(proc.pid, "running");
        proc.wakeOnSignals = undefined;
        woken.push(proc.pid);
      }
    }

    return woken;
  }

  /** Handle dead daemon processes that should be restarted. */
  handleRestarts(): OsProcess[] {
    const restarted: OsProcess[] = [];

    for (const proc of this.table.getByState("dead")) {
      const shouldRestart =
        proc.restartPolicy === "always" ||
        (proc.restartPolicy === "on-failure" && proc.exitCode !== 0);

      if (shouldRestart) {
        // Mark the dead process so it won't trigger another restart next tick
        proc.restartPolicy = "never";

        const newProc = this.table.spawn({
          type: proc.type,
          name: proc.name,
          objective: proc.objective,
          priority: proc.priority,
          model: proc.model,
          workingDir: proc.workingDir,
          parentPid: proc.parentPid,
          onParentDeath: proc.onParentDeath,
          restartPolicy: proc.type === "daemon" ? "on-failure" : "never",
          tokenBudget: proc.tokenBudget,
        });

        // DC-3: Wire supervisor.restore() — if the dead process had a checkpoint,
        // copy it to the restarted process so it resumes from saved state
        // rather than starting fresh (mirrors what fork() already does).
        if (proc.checkpoint) {
          newProc.checkpoint = JSON.parse(JSON.stringify(proc.checkpoint));
        }

        // Activate the restarted process so it actually runs
        this.table.transitionState(newProc.pid, "running");

        this.table.emitEvent({
          kind: "restarted",
          pid: newProc.pid,
          timestamp: new Date().toISOString(),
          details: { originalPid: proc.pid, restartPolicy: newProc.restartPolicy },
        });

        restarted.push(newProc);
      }
    }

    return restarted;
  }

  /** Reap dead processes — handle orphans and cleanup. */
  reapZombies(): void {
    const kernelPid = "kernel";
    for (const proc of this.table.getByState("dead")) {
      if (proc.children.length > 0) {
        this.table.reparentOrphans(proc.pid, kernelPid);
      }
    }
  }

  /** Set process priority. */
  setPriority(pid: string, priority: number): OsProcess {
    const proc = this.table.get(pid);
    if (!proc) throw new Error(`Process not found: ${pid}`);
    const safePriority = Number(priority);
    if (Number.isNaN(safePriority)) return proc; // ignore NaN reprioritize
    proc.priority = Math.max(0, Math.min(100, safePriority));
    return proc;
  }

  /** Get the depth of a process in the tree. */
  private getProcessDepth(parentPid: string | null): number {
    let depth = 0;
    let currentPid = parentPid;
    while (currentPid) {
      depth++;
      const parent = this.table.get(currentPid);
      if (!parent) break;
      currentPid = parent.parentPid;
    }
    return depth;
  }
}

/** Simple glob matching for signal patterns. */
function matchGlob(pattern: string, value: string): boolean {
  const regex = pattern
    .replace(/\*\*/g, "<<DOUBLESTAR>>")
    .replace(/\*/g, "[^:]*")
    .replace(/<<DOUBLESTAR>>/g, ".*");
  return new RegExp(`^${regex}$`).test(value);
}
