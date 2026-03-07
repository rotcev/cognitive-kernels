import { html, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { LensElement, lensBaseStyles } from "../tokens/base.js";
import type { LensSnapshot, LensEvent, LensTerminalLine, LensRun, ConnectionStatus, RunStatus, LensDagNode } from "../mock/types.js";
import { mockSnapshot, mockEvents, mockTerminalLines, mockRuns } from "../mock/factories.js";

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
  @property({ type: Array }) events: LensEvent[] = mockEvents();
  @property({ type: Array }) terminalLines: LensTerminalLine[] = mockTerminalLines();
  @property({ type: Array }) runs: LensRun[] = mockRuns();
  @property() narrativeText = "";
  @property() connectionStatus: ConnectionStatus = "disconnected";
  @property() activeRunId = "";

  @property() commandResponse = "";

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

  private get _activeRunStatus(): RunStatus | "" {
    const runId = this.activeRunId || this.snapshot?.runId || "";
    if (!runId) return "";
    const run = this.runs.find(r => r.id === runId);
    return run?.status ?? "";
  }

  /** Use processes as DAG nodes — s.dag.nodes is often incomplete (missing workers). */
  private _dagNodes(s: LensSnapshot): LensDagNode[] {
    return s.processes.map(p => ({
      pid: p.pid, name: p.name, type: p.type, state: p.state,
      role: p.role, priority: p.priority, parentPid: p.parentPid,
      backendKind: p.backendKind,
    }));
  }

  private get _emptySnapshot(): LensSnapshot {
    return {
      runId: "",
      tick: 0,
      goal: "",
      elapsed: 0,
      processes: [],
      dag: { nodes: [], edges: [] },
      blackboard: {},
      heuristics: [],
      deferrals: [],
      metrics: { totalTokens: 0, tokenRate: 0, processCount: 0, runningCount: 0, sleepingCount: 0, deadCount: 0, checkpointedCount: 0, suspendedCount: 0, dagDepth: 0, dagEdgeCount: 0, wallTimeElapsedMs: 0, tickCount: 0 },
    };
  }

  render() {
    const isLive = this.connectionStatus !== "disconnected";
    const s = this.snapshot ?? (isLive ? this._emptySnapshot : mockSnapshot());
    const runId = this.activeRunId || s.runId;
    const selectedProcess = s.processes.find(p => p.pid === this._selectedPid) ?? null;

    return html`
      <div class="topbar-area">
        <lens-topbar
          brandName="cognitive-lens"
          runLabel=${runId}
          elapsed=${this._formatElapsed(s.elapsed)}
          ?connected=${this.connectionStatus === "connected"}
          runStatus=${this._activeRunStatus}
        ></lens-topbar>
      </div>

      <div class="narrative-area">
        <lens-narrative-bar text=${this.narrativeText}></lens-narrative-bar>
      </div>

      <div class="sidebar-area">
        <lens-sidebar
          .runs=${this.runs}
          activeRunId=${runId}
          filter="All"
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
            .nodes=${this._dagNodes(s)}
            .edges=${s.dag.edges}
            @process-select=${(e: CustomEvent) => { this._selectedPid = e.detail.pid; this._drawerOpen = true; }}
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
          <lens-terminal-view .lines=${this.terminalLines}></lens-terminal-view>
        </div>
      </div>

      <div class="right-area">
        <lens-event-feed .events=${this.events}></lens-event-feed>
      </div>

      <div class="bottombar-area">
        <lens-bottombar .metrics=${s.metrics}></lens-bottombar>
      </div>

      <lens-process-drawer
        .process=${selectedProcess}
        .terminalLines=${this.terminalLines}
        .blackboard=${s.blackboard}
        ?open=${this._drawerOpen}
        @close=${() => { this._drawerOpen = false; }}
      ></lens-process-drawer>

      <lens-command-palette
        ?open=${this._paletteOpen}
        .suggestions=${this._paletteSuggestions}
        @close=${() => { this._paletteOpen = false; }}
        @query=${this._onPaletteQuery}
        @select=${this._onPaletteSelect}
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

  private get _paletteSuggestions() {
    return [
      { icon: "+", label: "Start new run..." },
      { icon: "\u25A0", label: "Cancel current run" },
      { icon: "T", label: "Show topology" },
      { icon: "B", label: "Show blackboard" },
      { icon: "#", label: "Show terminal" },
    ];
  }

  private _onPaletteQuery(e: CustomEvent) {
    this.dispatchEvent(new CustomEvent("command-query", {
      detail: { question: e.detail as string },
      bubbles: true, composed: true,
    }));
  }

  private _onPaletteSelect(e: CustomEvent) {
    const idx = e.detail as number;
    this._paletteOpen = false;
    switch (idx) {
      case 0:
        this.dispatchEvent(new CustomEvent("start-run-request", { bubbles: true, composed: true }));
        break;
      case 1:
        this.dispatchEvent(new CustomEvent("cancel-run-request", { bubbles: true, composed: true }));
        break;
      case 2:
        this._activeTab = "topology";
        break;
      case 3:
        this._activeTab = "blackboard";
        break;
      case 4:
        this._activeTab = "terminal";
        break;
    }
  }
}
