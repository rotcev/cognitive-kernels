import type { OsProcess, OsProcessTurnResult, OsProcessCommand, OsConfig, ExecutorCheckpointState } from "./types.js";
import type { ExecutorBackend, ExecutorCheckpointable } from "./executor-backend.js";
import type { Brain } from "../types.js";
import type { OsProtocolEmitter } from "./protocol-emitter.js";

type SubkernelEntry = {
  kernel: InstanceType<typeof import("./kernel.js").OsKernel>;
  name: string;
  ticksRun: number;
  halted: boolean;
  maxTicks: number;
};

export type SubkernelExecutorDeps = {
  client: Brain;
  parentConfig: OsConfig;
  parentRunId: string;
  workingDir: string;
  emitter?: OsProtocolEmitter;
};

/**
 * Sub-kernel executor backend — manages child Forge kernels.
 *
 * XXX TODO: This still drives child kernels via the old tick() loop (N ticks per parent turn).
 * Sub-kernels should use kernel.run() and the event-driven eventLoop() like the top-level
 * kernel does. The current tick-based approach artificially limits child kernel throughput
 * and doesn't benefit from the event-driven scheduling improvements (non-blocking housekeep,
 * meaningful tick semantics, immediate process completion rescheduling).
 * Converting requires changing executeOne() to call kernel.run(goal) and awaiting completion
 * rather than stepping N ticks, and removing the ticksPerParentTurn / maxTicks config.
 *
 * Safety: child kernels have systemProcess.enabled = false and childKernel.enabled = false,
 * preventing recursive sub-kernel spawning. Depth limit is enforced by the parent kernel.
 */
export class SubkernelExecutorBackend implements ExecutorBackend, ExecutorCheckpointable {
  readonly name = "kernel";
  private readonly entries: Map<string, SubkernelEntry> = new Map();
  private readonly client: Brain;
  private readonly parentConfig: OsConfig;
  private readonly parentRunId: string;
  private readonly workingDir: string;
  private readonly emitter?: OsProtocolEmitter;

  constructor(deps: SubkernelExecutorDeps) {
    this.client = deps.client;
    this.parentConfig = deps.parentConfig;
    this.parentRunId = deps.parentRunId;
    this.workingDir = deps.workingDir;
    this.emitter = deps.emitter;
  }

  get activeCount(): number {
    return this.entries.size;
  }

  /**
   * Boot a child kernel with safety constraints applied.
   * Uses lazy import to break circular dependency (subkernel-executor → kernel → subkernel-executor).
   */
  async start(proc: OsProcess): Promise<void> {
    if (!proc.backend || proc.backend.kind !== "kernel") {
      throw new Error(`SubkernelExecutorBackend.start() called for non-kernel process ${proc.pid}`);
    }

    const { goal, config: configOverrides, maxTicks } = proc.backend;

    // Build child config with safety constraints
    const childConfig: OsConfig = {
      ...this.parentConfig,
      kernel: {
        ...this.parentConfig.kernel,
        ...configOverrides,
        // Set parentKernelId so the child knows it's a child
        parentKernelId: this.parentRunId,
      },
      // Disable system processes and child kernels in the child — prevents recursion
      systemProcess: { enabled: false, maxSystemProcesses: 0, stdoutBufferLines: 0 },
      childKernel: { enabled: false, maxChildKernels: 0, defaultMaxTicks: 0, ticksPerParentTurn: 0, maxDepth: 0 },
    };

    // Lazy import to break circular dependency
    const { OsKernel } = await import("./kernel.js");

    const childKernel = new OsKernel(childConfig, this.client, this.workingDir, this.emitter);
    childKernel.boot(goal);

    this.emitter?.emit({
      action: "os_subkernel_spawn", // Cast to satisfy existing type — protocol emitter accepts any action string at runtime
      status: "started",
      message: `child_kernel=${proc.name} goal=${goal} parent=${this.parentRunId}`,
      agentId: proc.pid,
      agentName: proc.name,
    });

    const effectiveMaxTicks = maxTicks ?? this.parentConfig.childKernel.defaultMaxTicks;

    this.entries.set(proc.pid, {
      kernel: childKernel,
      name: proc.name,
      ticksRun: 0,
      halted: false,
      maxTicks: effectiveMaxTicks,
    });
  }

  /**
   * Execute one turn: run N child kernel ticks, publish snapshot to parent blackboard.
   * When the child halts, synthesize exit + bb_write with the child's final blackboard.
   */
  async executeOne(proc: OsProcess): Promise<OsProcessTurnResult> {
    const entry = this.entries.get(proc.pid);
    if (!entry) {
      return {
        pid: proc.pid,
        success: false,
        response: "Sub-kernel not found",
        tokensUsed: 0,
        commands: [],
      };
    }

    if (entry.halted) {
      return {
        pid: proc.pid,
        success: true,
        response: "Sub-kernel already halted",
        tokensUsed: 0,
        commands: [{ kind: "exit", code: 0, reason: "sub-kernel completed" }],
      };
    }

    const ticksPerTurn = this.parentConfig.childKernel.ticksPerParentTurn;
    let tokensThisTurn = 0;

    // Run N child ticks
    for (let i = 0; i < ticksPerTurn; i++) {
      if (entry.ticksRun >= entry.maxTicks) {
        entry.halted = true;
        break;
      }

      try {
        await entry.kernel.tick();
        entry.ticksRun++;
      } catch {
        entry.halted = true;
        break;
      }

      // Check if child kernel halted itself
      const snapshot = entry.kernel.snapshot();
      if (snapshot.progressMetrics.activeProcessCount === 0) {
        const allDead = snapshot.processes.every(p => p.state === "dead");
        if (allDead && snapshot.processes.length > 0) {
          entry.halted = true;
          break;
        }
      }
    }

    // Get child kernel snapshot
    const snapshot = entry.kernel.snapshot();
    tokensThisTurn = snapshot.progressMetrics.totalTokensUsed;

    // Emit tick summary
    this.emitter?.emit({
      action: "os_subkernel_tick",
      status: "completed",
      message: `child_kernel=${proc.name} ticks=${entry.ticksRun}/${entry.maxTicks} processes=${snapshot.processes.length} halted=${entry.halted}`,
      agentId: proc.pid,
      agentName: proc.name,
    });

    const commands: OsProcessCommand[] = [];

    // Publish child kernel snapshot to parent blackboard
    commands.push({
      kind: "bb_write",
      key: `child_kernel:${proc.name}:snapshot`,
      value: {
        tickCount: snapshot.tickCount,
        processCount: snapshot.processes.length,
        activeProcesses: snapshot.processes
          .filter(p => p.state !== "dead")
          .map(p => ({ name: p.name, state: p.state })),
        blackboard: snapshot.blackboard,
        halted: entry.halted,
      },
    });

    if (entry.halted) {
      // Publish final blackboard from child kernel
      if (snapshot.blackboard) {
        commands.push({
          kind: "bb_write",
          key: `child_kernel:${proc.name}:final_blackboard`,
          value: snapshot.blackboard,
        });
      }

      this.emitter?.emit({
        action: "os_subkernel_halt",
        status: "completed",
        message: `child_kernel=${proc.name} total_ticks=${entry.ticksRun}`,
        agentId: proc.pid,
        agentName: proc.name,
      });

      commands.push({
        kind: "exit",
        code: 0,
        reason: `sub-kernel completed after ${entry.ticksRun} ticks`,
      });
    }

    return {
      pid: proc.pid,
      success: true,
      response: entry.halted
        ? `Sub-kernel halted after ${entry.ticksRun} ticks`
        : `Sub-kernel ran ${entry.ticksRun}/${entry.maxTicks} ticks`,
      tokensUsed: tokensThisTurn,
      commands,
    };
  }

  // ─── Checkpoint-Restore (GAP-7) ──────────────────────────────────

  canCheckpoint(pid: string): boolean {
    const entry = this.entries.get(pid);
    return entry !== undefined && !entry.halted;
  }

  captureCheckpointState(pid: string): ExecutorCheckpointState | null {
    const entry = this.entries.get(pid);
    if (!entry) return null;
    return {
      kind: "kernel",
      childRunId: entry.kernel.runId,
      ticksRun: entry.ticksRun,
      halted: entry.halted,
    };
  }

  restoreFromCheckpoint(_pid: string, _state: ExecutorCheckpointState): void {
    // No-op: sub-kernels re-boot from scratch on restore.
    // The checkpoint metadata is preserved for observability.
  }

  /**
   * Dispose a sub-kernel — halt and shut down the child kernel.
   */
  dispose(pid: string): void {
    const entry = this.entries.get(pid);
    if (entry) {
      try {
        entry.kernel.shutdown();
      } catch {
        // Child kernel may have already shut down
      }

      this.emitter?.emit({
        action: "os_subkernel_halt",
        status: "completed",
        message: `child_kernel disposed pid=${pid} ticks=${entry.ticksRun}`,
        agentId: pid,
        agentName: entry.name,
      });

      this.entries.delete(pid);
    }
  }
}
