import { html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { LensElement, lensBaseStyles } from "../tokens/base.js";
import type { LensRun } from "../mock/types.js";

const FILTERS = ["All", "Running", "Done", "Failed"] as const;

@customElement("lens-sidebar")
export class LensSidebar extends LensElement {
  static override styles = [
    lensBaseStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        height: 100%;
        border-right: 1px solid var(--lens-border);
        background: var(--lens-bg-panel);
        overflow: hidden;
      }

      /* ── Header ── */
      .header {
        padding: 10px 12px 8px;
        border-bottom: 1px solid var(--lens-border);
      }

      .header h2 {
        font-family: var(--lens-font-mono);
        font-size: 10px;
        font-weight: 500;
        text-transform: uppercase;
        letter-spacing: 1px;
        color: var(--lens-text-dim);
        margin-bottom: 8px;
      }

      .filter-bar {
        display: flex;
        gap: 2px;
      }

      .filter-btn {
        font-family: var(--lens-font-mono);
        font-size: 10px;
        padding: 3px 8px;
        background: transparent;
        border: 1px solid transparent;
        color: var(--lens-text-dim);
        cursor: pointer;
        transition: all var(--lens-transition-fast);
      }

      .filter-btn:hover {
        color: var(--lens-text-secondary);
      }

      .filter-btn.active {
        color: var(--lens-accent);
        border-color: var(--lens-accent);
        background: var(--lens-accent-dim);
      }

      /* ── Run list ── */
      .run-list {
        flex: 1;
        overflow-y: auto;
        padding: 4px 0;
      }

      .run-item {
        padding: 8px 12px;
        cursor: pointer;
        border-left: 2px solid transparent;
        transition: all var(--lens-transition-fast);
        display: flex;
        flex-direction: column;
        gap: 3px;
      }

      .run-item:hover {
        background: var(--lens-bg-hover);
      }

      .run-item.active {
        background: var(--lens-bg-active);
        border-left-color: var(--lens-accent);
      }

      .run-top {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .status-dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        flex-shrink: 0;
      }

      .status-dot.running {
        background: var(--lens-green);
        box-shadow: 0 0 4px var(--lens-green);
        animation: pulse-dot 2s ease-in-out infinite;
      }
      .status-dot.completed {
        background: var(--lens-blue);
      }
      .status-dot.failed {
        background: var(--lens-red);
      }
      .status-dot.paused {
        background: var(--lens-amber);
      }
      .status-dot.canceled {
        background: var(--lens-gray);
      }

      @keyframes pulse-dot {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.5; }
      }

      .run-id {
        font-family: var(--lens-font-mono);
        font-size: 11px;
        color: var(--lens-text);
        font-weight: 500;
      }

      .run-time {
        font-family: var(--lens-font-mono);
        font-size: 10px;
        color: var(--lens-text-dim);
        margin-left: auto;
      }

      .run-goal {
        font-size: 11px;
        color: var(--lens-text-secondary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        padding-left: 15px;
      }
    `,
  ];

  @property({ type: Array }) runs: LensRun[] = [];
  @property() activeRunId = "";
  @property() filter = "All";

  private _formatElapsed(ms: number): string {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${String(sec).padStart(2, "0")}`;
  }

  private _onFilterChange(f: string) {
    this.dispatchEvent(
      new CustomEvent("filter-change", {
        detail: { filter: f },
        bubbles: true,
        composed: true,
      })
    );
  }

  private _onRunSelect(runId: string) {
    this.dispatchEvent(
      new CustomEvent("run-select", {
        detail: { runId },
        bubbles: true,
        composed: true,
      })
    );
  }

  private get _filteredRuns(): LensRun[] {
    if (this.filter === "All") return this.runs;
    const statusMap: Record<string, string[]> = {
      Running: ["running"],
      Done: ["completed"],
      Failed: ["failed"],
    };
    const allowed = statusMap[this.filter] ?? [];
    return this.runs.filter((r) => allowed.includes(r.status));
  }

  protected override render() {
    return html`
      <div class="header">
        <h2>Runs</h2>
        <div class="filter-bar">
          ${FILTERS.map(
            (f) => html`
              <button
                class="filter-btn ${f === this.filter ? "active" : ""}"
                @click=${() => this._onFilterChange(f)}
              >
                ${f}
              </button>
            `
          )}
        </div>
      </div>
      <div class="run-list">
        ${this._filteredRuns.map(
          (run) => html`
            <div
              class="run-item ${run.id === this.activeRunId ? "active" : ""}"
              @click=${() => this._onRunSelect(run.id)}
            >
              <div class="run-top">
                <span class="status-dot ${run.status}"></span>
                <span class="run-id">${run.id}</span>
                <span class="run-time">${this._formatElapsed(run.elapsed)}</span>
              </div>
              <div class="run-goal">${run.goal}</div>
            </div>
          `
        )}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "lens-sidebar": LensSidebar;
  }
}
