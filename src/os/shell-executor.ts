import { spawn, type ChildProcess } from "node:child_process";
import type { OsProcess, OsProcessTurnResult, OsProcessCommand, ExecutorCheckpointState } from "./types.js";
import type { ExecutorBackend, ExecutorCheckpointable } from "./executor-backend.js";

type ShellEntry = {
  child: ChildProcess;
  stdoutBuffer: string[];
  stderrBuffer: string[];
  /** Cumulative output — never drained, ring-buffered for bb_write continuity. */
  stdoutCumulative: string[];
  stderrCumulative: string[];
  exitCode: number | null;
  exited: boolean;
  maxBufferLines: number;
};

export type ShellExecutorDeps = {
  stdoutBufferLines?: number;
};

/**
 * Shell executor backend — manages real OS child processes.
 *
 * Each process is backed by a spawned child process. On each executeOne() call:
 * - Drains buffered stdout/stderr into bb_write commands
 * - If the child has exited, synthesizes an exit command
 *
 * IPC integration is automatic — stdout flows to the blackboard via synthesized
 * bb_write commands, so LLM processes can bb_read shell output.
 */
export class ShellExecutorBackend implements ExecutorBackend, ExecutorCheckpointable {
  readonly name = "system";
  private readonly entries: Map<string, ShellEntry> = new Map();
  private readonly defaultBufferLines: number;

  constructor(deps?: ShellExecutorDeps) {
    this.defaultBufferLines = deps?.stdoutBufferLines ?? 200;
  }

  get activeCount(): number {
    return this.entries.size;
  }

  /**
   * Start a real OS child process.
   * The process's backend descriptor provides command, args, and env.
   */
  async start(proc: OsProcess): Promise<void> {
    if (!proc.backend || proc.backend.kind !== "system") {
      throw new Error(`ShellExecutorBackend.start() called for non-system process ${proc.pid}`);
    }

    const { command, args, env } = proc.backend;

    const child = spawn(command, args ?? [], {
      cwd: proc.workingDir,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const entry: ShellEntry = {
      child,
      stdoutBuffer: [],
      stderrBuffer: [],
      stdoutCumulative: [],
      stderrCumulative: [],
      exitCode: null,
      exited: false,
      maxBufferLines: this.defaultBufferLines,
    };

    // Capture stdout into both per-tick drain buffer and cumulative ring buffer.
    // The drain buffer is spliced on each tick for delta bb_write.
    // The cumulative buffer persists across ticks so observers see full history.
    child.stdout?.on("data", (chunk: Buffer) => {
      const lines = chunk.toString().split("\n").filter(Boolean);
      for (const line of lines) {
        entry.stdoutBuffer.push(line);
        if (entry.stdoutBuffer.length > entry.maxBufferLines) {
          entry.stdoutBuffer.shift();
        }
        entry.stdoutCumulative.push(line);
        if (entry.stdoutCumulative.length > entry.maxBufferLines) {
          entry.stdoutCumulative.shift();
        }
      }
    });

    // Capture stderr into both per-tick drain buffer and cumulative ring buffer
    child.stderr?.on("data", (chunk: Buffer) => {
      const lines = chunk.toString().split("\n").filter(Boolean);
      for (const line of lines) {
        entry.stderrBuffer.push(line);
        if (entry.stderrBuffer.length > entry.maxBufferLines) {
          entry.stderrBuffer.shift();
        }
        entry.stderrCumulative.push(line);
        if (entry.stderrCumulative.length > entry.maxBufferLines) {
          entry.stderrCumulative.shift();
        }
      }
    });

    // Track exit
    child.on("exit", (code) => {
      entry.exitCode = code ?? 1;
      entry.exited = true;
    });

    child.on("error", () => {
      entry.exited = true;
      entry.exitCode = entry.exitCode ?? 1;
    });

    this.entries.set(proc.pid, entry);
  }

  /**
   * Execute one turn for a shell process.
   * Drains buffered output into bb_write commands.
   * If the process has exited, synthesizes an exit command.
   */
  async executeOne(proc: OsProcess): Promise<OsProcessTurnResult> {
    const entry = this.entries.get(proc.pid);
    if (!entry) {
      return {
        pid: proc.pid,
        success: false,
        response: "Shell process not found",
        tokensUsed: 0,
        commands: [],
      };
    }

    const commands: OsProcessCommand[] = [];

    // Only write to blackboard when new output has arrived (drain buffer non-empty).
    // Write the CUMULATIVE buffer so the blackboard always holds the full recent history,
    // not just the delta since last tick. This ensures observers spawned later still see
    // critical early output (e.g. URLs, ports, readiness messages).
    if (entry.stdoutBuffer.length > 0) {
      entry.stdoutBuffer.length = 0; // drain
      commands.push({
        kind: "bb_write",
        key: `shell:${proc.name}:stdout`,
        value: entry.stdoutCumulative.join("\n"),
      });
    }

    if (entry.stderrBuffer.length > 0) {
      entry.stderrBuffer.length = 0; // drain
      commands.push({
        kind: "bb_write",
        key: `shell:${proc.name}:stderr`,
        value: entry.stderrCumulative.join("\n"),
      });
    }

    // If process exited, synthesize exit command
    if (entry.exited) {
      commands.push({
        kind: "exit",
        code: entry.exitCode ?? 1,
        reason: `shell process exited with code ${entry.exitCode}`,
      });
    }

    return {
      pid: proc.pid,
      success: true,
      response: entry.exited
        ? `Shell process exited with code ${entry.exitCode}`
        : "Shell process running",
      tokensUsed: 0, // Shell processes don't consume LLM tokens
      commands,
    };
  }

  // ─── Checkpoint-Restore (GAP-7) ──────────────────────────────────
  // Shell processes are external OS processes — they can't be serialized.

  canCheckpoint(_pid: string): boolean {
    return false;
  }

  captureCheckpointState(_pid: string): ExecutorCheckpointState | null {
    return null;
  }

  restoreFromCheckpoint(_pid: string, _state: ExecutorCheckpointState): void {
    // No-op: shell processes cannot be restored from checkpoint
  }

  /**
   * Dispose a shell process — sends SIGTERM.
   */
  dispose(pid: string): void {
    const entry = this.entries.get(pid);
    if (entry) {
      if (!entry.exited) {
        try {
          entry.child.kill("SIGTERM");
        } catch {
          // Process may have already exited
        }
      }
      this.entries.delete(pid);
    }
  }
}
