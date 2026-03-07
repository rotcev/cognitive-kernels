import { html, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { LensElement, lensBaseStyles } from "../tokens/base.js";
import {
  LensClient,
  type LensSnapshot,
  type LensTerminalLine,
  type ConnectionStatus,
  type LensEvent,
  type LensRun,
  type RunStatus,
  type StartRunInput,
} from "../mock/types.js";

import "./dashboard.js";

const MAX_EVENTS = 500;
const MAX_TERMINAL_LINES = 2000;
const RUN_POLL_INTERVAL = 5000;

/** Extract a short human-readable summary of tool arguments. */
function summarizeToolArgs(toolName: string, args: unknown): string {
  if (!args || typeof args !== "object") return typeof args === "string" ? args.slice(0, 150) : "";
  const a = args as Record<string, unknown>;

  // Show the most useful field per tool type
  if (toolName === "Bash" || toolName === "bash") return truncate(String(a.command ?? a.cmd ?? ""), 150);
  if (toolName === "Read" || toolName === "read") return truncate(String(a.file_path ?? a.path ?? ""), 150);
  if (toolName === "Write" || toolName === "write") return truncate(String(a.file_path ?? a.path ?? ""), 150);
  if (toolName === "Edit" || toolName === "edit") return truncate(String(a.file_path ?? a.path ?? ""), 150);
  if (toolName === "Grep" || toolName === "grep") return truncate(`/${a.pattern ?? ""}/ ${a.path ?? ""}`, 150);
  if (toolName === "Glob" || toolName === "glob") return truncate(String(a.pattern ?? ""), 150);
  if (toolName === "Task") return truncate(String(a.description ?? a.prompt ?? ""), 150);

  // Generic: show first string-valued key
  for (const [k, v] of Object.entries(a)) {
    if (typeof v === "string" && v.length > 0) return truncate(`${k}: ${v}`, 150);
  }
  return "";
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

/** Map raw protocol event actions to display-friendly categories and extract readable text. */
function mapEventAction(rawAction: string, rawMessage: string): { action: string; message: string } {
  switch (rawAction) {
    case "os_llm_stream": {
      // Message is JSON like {"type":"text_delta","text":"hello"}
      try {
        const inner = JSON.parse(rawMessage);
        if (inner.type === "text_delta") return { action: "llm", message: inner.text ?? "" };
        if (inner.type === "tool_started") {
          const args = inner.argumentsSummary;
          const detail = args ? summarizeToolArgs(inner.toolName, args) : "";
          return { action: "command", message: `${inner.toolName ?? "unknown"}${detail ? ": " + detail : ""}` };
        }
        if (inner.type === "tool_completed") {
          const summary = typeof inner.resultSummary === "string" ? inner.resultSummary.slice(0, 120) : "";
          return { action: "command", message: `${inner.toolName ?? ""} done${summary ? " — " + summary : ""}` };
        }
        if (inner.type === "tool_failed") return { action: "error", message: `${inner.toolName}: ${inner.error ?? "failed"}` };
        if (inner.type === "status") return { action: "tick", message: inner.status ?? rawMessage };
        return { action: "llm", message: inner.text ?? inner.type ?? rawMessage };
      } catch {
        return { action: "llm", message: rawMessage };
      }
    }
    case "os_process_spawn":
    case "boot":
      return { action: "spawn", message: rawMessage };
    case "os_process_kill":
    case "os_process_exit":
      return { action: "exit", message: rawMessage };
    case "os_tick":
    case "os_snapshot":
      return { action: "tick", message: rawMessage };
    case "os_checkpoint":
      return { action: "checkpoint", message: rawMessage };
    case "os_metacog":
    case "os_awareness_eval":
      return { action: "llm", message: rawMessage };
    case "tool_started":
    case "tool_completed":
      return { action: "command", message: rawMessage };
    default:
      // Pass through actions that already match display categories
      if (["tick", "spawn", "llm", "command", "exit", "checkpoint", "error"].includes(rawAction)) {
        return { action: rawAction, message: rawMessage };
      }
      return { action: "llm", message: rawMessage };
  }
}

@customElement("lens-app")
export class LensApp extends LensElement {
  static override styles = [
    lensBaseStyles,
    css`
      :host {
        display: block;
        height: 100vh;
        overflow: hidden;
      }
    `,
  ];

  /** WebSocket URL for Lens server, e.g. "ws://localhost:3200". */
  @property() url = "";

  /** REST API base URL, e.g. "http://localhost:3200". Derived from url if not set. */
  @property() apiUrl = "";

  @state() private _client: LensClient | null = null;
  @state() private _snapshot: LensSnapshot | null = null;
  @state() private _events: LensEvent[] = [];
  @state() private _terminalLines: LensTerminalLine[] = [];
  @state() private _runs: LensRun[] = [];
  @state() private _narrativeText = "";
  @state() private _connectionStatus: ConnectionStatus = "disconnected";
  @state() private _activeRunId = "";
  @state() private _commandResponse = "";

  private _cleanups: Array<() => void> = [];
  private _pollTimer: ReturnType<typeof setInterval> | null = null;

  private get _resolvedApiUrl(): string {
    if (this.apiUrl) return this.apiUrl;
    if (!this.url) return "";
    // Convert ws(s)://host:port to http(s)://host:port
    return this.url.replace(/^ws(s?):\/\//, "http$1://");
  }

  override connectedCallback() {
    super.connectedCallback();
    if (this.url) {
      this._connect();
    }
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._disconnect();
  }

  override updated(changed: Map<string, unknown>) {
    if (changed.has("url") && this.url) {
      this._disconnect();
      this._connect();
    }
  }

  // ── WebSocket connection ────────────────────────────────────────

  private _connect() {
    const client = new LensClient({ url: this.url });
    this._client = client;

    const cleanups: Array<() => void> = [];

    cleanups.push(client.on("connection", ({ state: connState }) => {
      if (connState === "connected") {
        this._connectionStatus = "connected";
        // Fetch run list on connect
        void this._fetchRuns();
      } else if (connState === "connecting") {
        this._connectionStatus = this._connectionStatus === "disconnected"
          ? "disconnected"
          : "reconnecting";
      } else {
        this._connectionStatus = "disconnected";
      }
    }));

    cleanups.push(client.on("state", ({ runId, snapshot }) => {
      this._snapshot = snapshot;
      this._updateRunFromSnapshot(runId, snapshot);
    }));

    cleanups.push(client.on("event", ({ event }) => {
      const rawAction = (event.action as string) ?? "unknown";
      const agentName = event.agentName as string | undefined;
      const rawMessage = (event.message as string) ?? "";
      const timestamp = (event.timestamp as string) ?? new Date().toISOString();
      const status = (event.status as string) ?? "unknown";

      // Map raw protocol actions to display-friendly categories
      const { action, message } = mapEventAction(rawAction, rawMessage);

      // Skip noisy stream events with empty text
      if (action === "llm" && !message.trim()) return;

      // Coalesce streaming text chunks from the same agent+action into one entry
      const prev = this._events[0];
      if (
        prev &&
        prev.action === action &&
        prev.agentName === agentName &&
        action === "llm"
      ) {
        const merged = { ...prev, message: prev.message + message };
        this._events = [merged, ...this._events.slice(1)];
        return;
      }

      const lensEvent: LensEvent = { action, status, timestamp, agentName, message };
      this._events = [lensEvent, ...this._events].slice(0, MAX_EVENTS);
    }));

    cleanups.push(client.on("terminal_line", ({ line }) => {
      this._terminalLines = [...this._terminalLines, line].slice(-MAX_TERMINAL_LINES);
    }));

    cleanups.push(client.on("narrative", ({ text }) => {
      this._narrativeText = text;
    }));

    cleanups.push(client.on("run_end", ({ runId, reason }) => {
      this._runs = this._runs.map(r =>
        r.id === runId
          ? { ...r, status: reason === "completed" ? "completed" as const : "failed" as const }
          : r
      );
    }));

    cleanups.push(client.on("command_response", ({ text, done }) => {
      this._commandResponse = done ? text : this._commandResponse + text;
    }));

    this._cleanups = cleanups;

    // Poll run list periodically
    this._pollTimer = setInterval(() => void this._fetchRuns(), RUN_POLL_INTERVAL);

    void client.connect().catch(() => {
      // Will retry via reconnect
    });
  }

  private _disconnect() {
    for (const cleanup of this._cleanups) cleanup();
    this._cleanups = [];
    this._client?.disconnect();
    this._client = null;
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  // ── REST API ────────────────────────────────────────────────────

  private async _fetchRuns() {
    const base = this._resolvedApiUrl;
    if (!base) return;

    try {
      const res = await fetch(`${base}/runs`);
      if (!res.ok) return;
      const data = await res.json() as { runs: Array<{
        id: string;
        status: string;
        input?: { goal?: string };
        createdAt: string;
        startedAt?: string;
        endedAt?: string;
      }> };

      this._runs = data.runs.map(r => {
        const elapsed = r.endedAt
          ? new Date(r.endedAt).getTime() - new Date(r.startedAt ?? r.createdAt).getTime()
          : r.startedAt
            ? Date.now() - new Date(r.startedAt).getTime()
            : 0;
        return {
          id: r.id,
          status: this._mapRunStatus(r.status),
          goal: r.input?.goal ?? "",
          createdAt: r.createdAt,
          elapsed,
        };
      });
    } catch {
      // Silently fail — polling will retry
    }
  }

  private _mapRunStatus(apiStatus: string): RunStatus {
    switch (apiStatus) {
      case "running": return "running";
      case "completed": return "completed";
      case "failed": return "failed";
      case "paused": return "paused";
      case "canceled": return "canceled";
      default: return "running";
    }
  }

  async startRun(input: StartRunInput): Promise<string | null> {
    const base = this._resolvedApiUrl;
    if (!base) return null;

    try {
      const res = await fetch(`${base}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) return null;

      const data = await res.json() as { run: { id: string } };
      const runId = data.run.id;

      // Auto-subscribe to the new run
      await this._fetchRuns();
      this.subscribeRun(runId);
      return runId;
    } catch {
      return null;
    }
  }

  async cancelRun(runId?: string): Promise<boolean> {
    const id = runId ?? this._activeRunId;
    if (!id) return false;

    const base = this._resolvedApiUrl;
    if (!base) return false;

    try {
      const res = await fetch(`${base}/runs/${id}`, { method: "DELETE" });
      if (!res.ok) return false;

      this._runs = this._runs.map(r =>
        r.id === id ? { ...r, status: "canceled" as const } : r
      );
      return true;
    } catch {
      return false;
    }
  }

  async pauseRun(runId?: string): Promise<boolean> {
    const id = runId ?? this._activeRunId;
    if (!id) return false;

    const base = this._resolvedApiUrl;
    if (!base) return false;

    try {
      const res = await fetch(`${base}/runs/${id}/pause`, { method: "POST" });
      if (!res.ok) return false;

      this._runs = this._runs.map(r =>
        r.id === id ? { ...r, status: "paused" as const } : r
      );
      return true;
    } catch {
      return false;
    }
  }

  async resumeRun(runId?: string): Promise<boolean> {
    const id = runId ?? this._activeRunId;
    if (!id) return false;

    const base = this._resolvedApiUrl;
    if (!base) return false;

    try {
      const res = await fetch(`${base}/runs/${id}/resume`, { method: "POST" });
      if (!res.ok) return false;

      this._runs = this._runs.map(r =>
        r.id === id ? { ...r, status: "running" as const } : r
      );
      return true;
    } catch {
      return false;
    }
  }

  // ── Run subscription ────────────────────────────────────────────

  private _updateRunFromSnapshot(runId: string, snapshot: LensSnapshot) {
    const existing = this._runs.find(r => r.id === runId);
    if (existing) {
      this._runs = this._runs.map(r =>
        r.id === runId
          ? { ...r, elapsed: snapshot.elapsed, goal: snapshot.goal }
          : r
      );
    } else {
      this._runs = [
        {
          id: runId,
          status: "running" as const,
          goal: snapshot.goal,
          createdAt: new Date(Date.now() - snapshot.elapsed).toISOString(),
          elapsed: snapshot.elapsed,
        },
        ...this._runs,
      ];
    }
  }

  subscribeRun(runId: string) {
    // Unsubscribe from old run
    if (this._activeRunId && this._client) {
      this._client.unsubscribe(this._activeRunId);
      this._client.unsubscribeTerminal(this._activeRunId);
    }

    this._activeRunId = runId;
    this._events = [];
    this._terminalLines = [];
    this._snapshot = null;
    this._narrativeText = "";
    this._commandResponse = "";

    if (this._client) {
      this._client.subscribe(runId);
      this._client.subscribeTerminal(runId);
    }
  }

  // ── Event handlers from dashboard ───────────────────────────────

  private _onRunSelect(e: CustomEvent) {
    const runId = e.detail.runId as string;
    if (runId === this._activeRunId) return;
    this.subscribeRun(runId);
  }

  private _onStartRunRequest() {
    // Prompt-less start for now — use a default goal
    // Products should override this with their own UI
    const goal = prompt("Enter goal for the new run:");
    if (goal) {
      void this.startRun({ goal });
    }
  }

  private _onCancelRunRequest() {
    if (this._activeRunId) {
      void this.cancelRun();
    }
  }

  private _onPauseRunRequest() {
    if (this._activeRunId) {
      void this.pauseRun();
    }
  }

  private _onResumeRunRequest() {
    if (this._activeRunId) {
      void this.resumeRun();
    }
  }

  private _onCommandQuery(e: CustomEvent) {
    if (!this._client || !this._activeRunId) return;
    this._commandResponse = "";
    this._client.query(this._activeRunId, e.detail.question as string);
  }

  protected override render() {
    return html`
      <lens-dashboard
        .snapshot=${this._snapshot ?? undefined}
        .events=${this._events}
        .terminalLines=${this._terminalLines}
        .runs=${this._runs}
        narrativeText=${this._narrativeText}
        connectionStatus=${this._connectionStatus}
        activeRunId=${this._activeRunId}
        commandResponse=${this._commandResponse}
        @run-select=${this._onRunSelect}
        @start-run-request=${this._onStartRunRequest}
        @cancel-run-request=${this._onCancelRunRequest}
        @pause-run-request=${this._onPauseRunRequest}
        @resume-run-request=${this._onResumeRunRequest}
        @command-query=${this._onCommandQuery}
      ></lens-dashboard>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "lens-app": LensApp;
  }
}
