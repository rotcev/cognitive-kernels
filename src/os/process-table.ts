import { randomUUID } from "node:crypto";
import type {
  OsProcess,
  OsProcessState,
  OsProcessDescriptor,
  OsProcessEvent,
  OsParentDeathPolicy,
} from "./types.js";
import { VALID_STATE_TRANSITIONS } from "./types.js";

export class OsProcessTable {
  private processes: Map<string, OsProcess> = new Map();
  private _events: OsProcessEvent[] = [];

  get events(): OsProcessEvent[] {
    return this._events;
  }

  get size(): number {
    return this.processes.size;
  }

  generatePid(): string {
    return `os-proc-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  }

  spawn(descriptor: OsProcessDescriptor): OsProcess {
    const now = new Date().toISOString();
    const pid = this.generatePid();

    const isDaemon = descriptor.type === "daemon";

    // Default to "orphan" for ALL process types — when a parent dies, children
    // get reparented to init (kernel) instead of being cascade-killed.
    // This mirrors Unix semantics and prevents the common failure mode where
    // an orchestrator exits before children complete, killing all of them.
    // Use cascade only when explicitly requested via descriptor.onParentDeath.
    const defaultOnParentDeath: OsParentDeathPolicy = "orphan";

    const defaultRestartPolicy = isDaemon ? "on-failure" as const : "never" as const;

    const process: OsProcess = {
      pid,
      type: descriptor.type,
      state: "spawned",
      name: descriptor.name,
      parentPid: descriptor.parentPid ?? null,
      objective: descriptor.objective,
      priority: descriptor.priority ?? 50,
      spawnedAt: now,
      lastActiveAt: now,
      tickCount: 0,
      tokensUsed: 0,
      model: descriptor.model ?? "claude-sonnet-4-6",
      workingDir: descriptor.workingDir ?? ".",
      children: [],
      onParentDeath: descriptor.onParentDeath ?? defaultOnParentDeath,
      restartPolicy: descriptor.restartPolicy ?? defaultRestartPolicy,
      tokenBudget: descriptor.tokenBudget,
      wakeOnSignals: descriptor.wakeOnSignals,
      backend: descriptor.backend,
      completionCriteria: descriptor.completionCriteria,
      capabilities: descriptor.capabilities,
    };

    this.processes.set(pid, process);

    // Register as child of parent
    if (process.parentPid) {
      const parent = this.processes.get(process.parentPid);
      if (parent) {
        parent.children.push(pid);
      }
    }

    this._events.push({
      kind: "spawned",
      pid,
      timestamp: now,
      details: { type: descriptor.type, name: descriptor.name },
    });

    return process;
  }

  get(pid: string): OsProcess | undefined {
    return this.processes.get(pid);
  }

  getAll(): OsProcess[] {
    return [...this.processes.values()];
  }

  getByState(state: OsProcessState): OsProcess[] {
    return this.getAll().filter((p) => p.state === state);
  }

  getChildren(pid: string): OsProcess[] {
    const process = this.processes.get(pid);
    if (!process) return [];
    return process.children
      .map((childPid) => this.processes.get(childPid))
      .filter((p): p is OsProcess => p !== undefined);
  }

  getRunnable(): OsProcess[] {
    return this.getAll().filter((p) => p.state === "running");
  }

  transitionState(pid: string, newState: OsProcessState): OsProcess {
    const process = this.processes.get(pid);
    if (!process) {
      throw new Error(`Process not found: ${pid}`);
    }

    const validTransitions = VALID_STATE_TRANSITIONS[process.state];
    if (!validTransitions.includes(newState)) {
      throw new Error(
        `Invalid state transition: ${process.state} → ${newState} for process ${pid}`,
      );
    }

    const oldState = process.state;
    process.state = newState;
    process.lastActiveAt = new Date().toISOString();

    this._events.push({
      kind: "state_changed",
      pid,
      timestamp: process.lastActiveAt,
      details: { from: oldState, to: newState },
    });

    return process;
  }

  kill(pid: string, cascade: boolean, reason: string): string[] {
    const process = this.processes.get(pid);
    if (!process) {
      throw new Error(`Process not found: ${pid}`);
    }

    const killed: string[] = [];

    if (cascade) {
      // Kill children first (depth-first)
      for (const childPid of [...process.children]) {
        killed.push(...this.kill(childPid, true, reason));
      }
    }

    if (process.state !== "dead") {
      process.state = "dead";
      process.exitReason = reason;
      process.lastActiveAt = new Date().toISOString();

      this._events.push({
        kind: "killed",
        pid,
        timestamp: process.lastActiveAt,
        details: { reason, cascade },
      });

      killed.push(pid);
    }

    return killed;
  }

  reparentOrphans(deadParentPid: string, newParentPid: string): void {
    const deadParent = this.processes.get(deadParentPid);
    if (!deadParent) return;

    const newParent = this.processes.get(newParentPid);
    const childrenPids = [...deadParent.children];

    for (const childPid of childrenPids) {
      const child = this.processes.get(childPid);
      if (!child || child.state === "dead") continue;

      if (child.onParentDeath === "orphan") {
        // Remove from dead parent's children
        const idx = deadParent.children.indexOf(childPid);
        if (idx !== -1) deadParent.children.splice(idx, 1);

        if (newParent) {
          // Reparent to the specified parent
          child.parentPid = newParentPid;
          newParent.children.push(childPid);
        } else {
          // No valid reparent target — promote to root process
          child.parentPid = null;
        }

        this._events.push({
          kind: "reparented",
          pid: childPid,
          timestamp: new Date().toISOString(),
          details: {
            oldParentPid: deadParentPid,
            newParentPid: child.parentPid ?? "root",
          },
        });
      } else {
        // Explicit cascade policy — kill the child
        this.kill(childPid, true, `Parent ${deadParentPid} died (cascade policy)`);
      }
    }
  }

  /** Push an external event (used by supervisor for checkpoint/restore/restart events). */
  emitEvent(event: OsProcessEvent): void {
    this._events.push(event);
  }

  clearEvents(): OsProcessEvent[] {
    const events = [...this._events];
    this._events.length = 0;
    return events;
  }
}
