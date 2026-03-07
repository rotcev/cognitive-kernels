import { html, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { LensElement, lensBaseStyles } from "../tokens/base.js";
import type { LensSnapshot } from "../mock/types.js";
import { mockSnapshot } from "../mock/factories.js";

// Import all components
import "../layout/topbar.js";
import "../layout/bottombar.js";
import "../layout/tabbar.js";
import "../layout/sidebar.js";
import "../domain/narrative-bar.js";
import "../domain/connection-badge.js";
import "../domain/process-tree.js";
import "../domain/event-feed.js";
import "../domain/blackboard.js";
import "../domain/heuristic-card.js";
import "../domain/deferral-card.js";
import "../domain/terminal-view.js";
import "../domain/dag-view.js";
import "../domain/process-drawer.js";
import "../domain/expanded-view.js";
import "../domain/command-palette.js";
import "../domain/metrics-bar.js";

const CENTER_TABS = [
  { id: "topology", label: "Topology" },
  { id: "dag", label: "DAG" },
  { id: "blackboard", label: "Blackboard" },
  { id: "heuristics", label: "Heuristics" },
  { id: "deferrals", label: "Deferrals" },
  { id: "terminal", label: "Terminal" },
];

@customElement("lens-dashboard")
export class LensDashboard extends LensElement {
  static styles = [
    lensBaseStyles,
    css`
      :host {
        display: grid;
        grid-template-rows: var(--lens-topbar-h) var(--lens-narrative-h) 1fr var(--lens-bottombar-h);
        grid-template-columns: var(--lens-sidebar-w) 1fr var(--lens-rightpanel-w);
        height: 100vh;
        overflow: hidden;
        background: var(--lens-bg-root);
        position: relative;
      }

      /* CRT scanline overlay */
      :host::after {
        content: '';
        position: fixed;
        inset: 0;
        pointer-events: none;
        z-index: 9998;
        background: repeating-linear-gradient(
          0deg,
          transparent,
          transparent 2px,
          rgba(0,0,0,0.03) 2px,
          rgba(0,0,0,0.03) 4px
        );
        mix-blend-mode: multiply;
      }

      .topbar-area {
        grid-column: 1 / -1;
        grid-row: 1;
      }

      .narrative-area {
        grid-column: 1 / -1;
        grid-row: 2;
      }

      .sidebar-area {
        grid-row: 3;
        grid-column: 1;
      }

      .center-area {
        grid-row: 3;
        grid-column: 2;
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }

      .right-area {
        grid-row: 3;
        grid-column: 3;
        border-left: 1px solid var(--lens-border);
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }

      .bottombar-area {
        grid-column: 1 / -1;
        grid-row: 4;
      }

      .tab-content {
        flex: 1;
        overflow: hidden;
        display: none;
      }

      .tab-content.active {
        display: flex;
        flex-direction: column;
      }

      .heuristics-scroll, .deferrals-scroll {
        flex: 1;
        overflow-y: auto;
        padding: 16px;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      lens-event-feed {
        flex: 1;
        overflow: hidden;
      }
    `,
  ];

  @property({ type: Object }) snapshot: LensSnapshot = mockSnapshot();

  @state() private _activeTab = "topology";
  @state() private _selectedPid: string | null = null;
  @state() private _drawerOpen = false;
  @state() private _paletteOpen = false;

  private _formatElapsed(ms: number): string {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  }

  render() {
    const s = this.snapshot;
    const selectedProcess = s.processes.find(p => p.pid === this._selectedPid) ?? null;

    return html`
      <div class="topbar-area">
        <lens-topbar
          brandName="cognitive-lens"
          runLabel=${s.runId}
          elapsed=${this._formatElapsed(s.elapsed)}
          ?connected=${true}
        ></lens-topbar>
      </div>

      <div class="narrative-area">
        <lens-narrative-bar text="metacog orchestrating JWT authentication — implementer at 80%, jwt-handler checkpointed for test validation"></lens-narrative-bar>
      </div>

      <div class="sidebar-area">
        <lens-sidebar
          .runs=${[
            { id: s.runId, status: "running" as const, goal: s.goal, createdAt: new Date(Date.now() - s.elapsed).toISOString(), elapsed: s.elapsed },
            { id: "a3c91f02", status: "completed" as const, goal: "Set up database schema and migrations", createdAt: new Date(Date.now() - 3600000).toISOString(), elapsed: 298000 },
            { id: "ff120e45", status: "failed" as const, goal: "Refactor codebase to use DI", createdAt: new Date(Date.now() - 7200000).toISOString(), elapsed: 200000 },
          ]}
          activeRunId=${s.runId}
          filter="all"
        ></lens-sidebar>
      </div>

      <div class="center-area">
        <lens-tabbar
          .tabs=${CENTER_TABS}
          activeTab=${this._activeTab}
          variant="center"
          @tab-change=${(e: CustomEvent) => { this._activeTab = e.detail.tab; }}
        ></lens-tabbar>

        <div class="tab-content ${this._activeTab === "topology" ? "active" : ""}">
          <lens-process-tree
            .processes=${s.processes}
            selectedPid=${this._selectedPid ?? ""}
            @process-select=${(e: CustomEvent) => { this._selectedPid = e.detail.pid; this._drawerOpen = true; }}
          ></lens-process-tree>
        </div>

        <div class="tab-content ${this._activeTab === "dag" ? "active" : ""}">
          <lens-dag-view
            .nodes=${s.dag.nodes}
            .edges=${s.dag.edges}
          ></lens-dag-view>
        </div>

        <div class="tab-content ${this._activeTab === "blackboard" ? "active" : ""}">
          <lens-blackboard .entries=${s.blackboard}></lens-blackboard>
        </div>

        <div class="tab-content ${this._activeTab === "heuristics" ? "active" : ""}">
          <div class="heuristics-scroll">
            ${s.heuristics.map(h => html`
              <lens-heuristic-card .heuristic=${h}></lens-heuristic-card>
            `)}
          </div>
        </div>

        <div class="tab-content ${this._activeTab === "deferrals" ? "active" : ""}">
          <div class="deferrals-scroll">
            ${s.deferrals.map(d => html`
              <lens-deferral-card .deferral=${d}></lens-deferral-card>
            `)}
          </div>
        </div>

        <div class="tab-content ${this._activeTab === "terminal" ? "active" : ""}">
          <lens-terminal-view
            .lines=${[
              { seq: 1, timestamp: new Date(Date.now() - 175000).toISOString(), pid: "proc-metacog-001", processName: "metacog", level: "system" as const, text: "Process spawned: metacog (daemon, priority=100)" },
              { seq: 2, timestamp: new Date(Date.now() - 174000).toISOString(), pid: "proc-metacog-001", processName: "metacog", level: "info" as const, text: "Goal: Implement authentication system with JWT tokens" },
              { seq: 3, timestamp: new Date(Date.now() - 173000).toISOString(), pid: "proc-metacog-001", processName: "metacog", level: "thinking" as const, text: "I need to break this into phases: architecture, implementation, testing." },
              { seq: 4, timestamp: new Date(Date.now() - 170000).toISOString(), pid: "proc-metacog-001", processName: "metacog", level: "tool" as const, text: "os_spawn: architect (proc-arch-002)" },
              { seq: 5, timestamp: new Date(Date.now() - 120000).toISOString(), pid: "proc-metacog-001", processName: "metacog", level: "output" as const, text: "Architect exited [0]. Architecture committed to blackboard." },
              { seq: 6, timestamp: new Date(Date.now() - 8000).toISOString(), pid: "proc-middleware-005", processName: "auth-middleware", level: "error" as const, text: "TypeError: Cannot read property 'role' of undefined" },
            ]}
          ></lens-terminal-view>
        </div>
      </div>

      <div class="right-area">
        <lens-event-feed
          .events=${[
            { action: "tick", status: "completed", timestamp: new Date(Date.now() - 3000).toISOString(), message: "tick=42 active=3 sleeping=1 dead=1" },
            { action: "llm", status: "started", timestamp: new Date(Date.now() - 4500).toISOString(), agentName: "auth-middleware", message: "Implementing role-based access control..." },
            { action: "command", status: "completed", timestamp: new Date(Date.now() - 8000).toISOString(), agentName: "implementer", message: "write_blackboard: auth.middleware_progress = 80%" },
            { action: "checkpoint", status: "completed", timestamp: new Date(Date.now() - 30000).toISOString(), agentName: "jwt-handler", message: "Checkpoint: waiting for test validation" },
            { action: "spawn", status: "completed", timestamp: new Date(Date.now() - 80000).toISOString(), agentName: "implementer", message: "Spawned auth-middleware" },
            { action: "spawn", status: "completed", timestamp: new Date(Date.now() - 100000).toISOString(), agentName: "implementer", message: "Spawned jwt-handler" },
            { action: "exit", status: "completed", timestamp: new Date(Date.now() - 120000).toISOString(), agentName: "architect", message: "Exited with code 0" },
            { action: "spawn", status: "completed", timestamp: new Date(Date.now() - 170000).toISOString(), agentName: "metacog", message: "Spawned architect" },
          ]}
        ></lens-event-feed>
      </div>

      <div class="bottombar-area">
        <lens-bottombar .metrics=${s.metrics}></lens-bottombar>
      </div>

      <lens-process-drawer
        .process=${selectedProcess}
        ?open=${this._drawerOpen}
        @close=${() => { this._drawerOpen = false; }}
      ></lens-process-drawer>

      <lens-command-palette
        ?open=${this._paletteOpen}
        .suggestions=${[
          { icon: ">", label: "Show process tree" },
          { icon: "?", label: "Explain current state" },
          { icon: "#", label: "Search blackboard" },
        ]}
        @close=${() => { this._paletteOpen = false; }}
      ></lens-command-palette>
    `;
  }

  connectedCallback() {
    super.connectedCallback();
    this._onKeydown = this._onKeydown.bind(this);
    document.addEventListener("keydown", this._onKeydown);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener("keydown", this._onKeydown);
  }

  private _onKeydown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === "k") {
      e.preventDefault();
      this._paletteOpen = !this._paletteOpen;
    }
  }
}
