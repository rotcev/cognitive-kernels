import { html, css, nothing } from "lit";
import { customElement, property, state, query } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { LensElement, lensBaseStyles } from "../tokens/base.js";
import type { LensEvent } from "../mock/types.js";

const EVENT_TYPES = ["tick", "spawn", "llm", "command", "exit", "checkpoint", "error"] as const;

const actionColors: Record<string, string> = {
  tick: "var(--lens-text-dim)",
  spawn: "var(--lens-cyan)",
  llm: "var(--lens-green)",
  command: "var(--lens-amber)",
  exit: "var(--lens-gray)",
  checkpoint: "var(--lens-blue)",
  error: "var(--lens-red)",
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toTimeString().slice(0, 8);
}

@customElement("lens-event-feed")
export class LensEventFeed extends LensElement {
  static override styles = [
    lensBaseStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        height: 100%;
        font-family: var(--lens-font-mono);
        background: var(--lens-bg-panel);
      }

      .header {
        padding: 8px 12px 4px;
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--lens-text-dim);
      }

      .filters {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        padding: 4px 12px 8px;
        border-bottom: 1px solid var(--lens-border);
      }

      .filter-btn {
        padding: 2px 8px;
        font-family: var(--lens-font-mono);
        font-size: 10px;
        border: 1px solid var(--lens-border);
        border-radius: var(--lens-radius-sm);
        background: transparent;
        color: var(--lens-text-dim);
        cursor: pointer;
        transition: all var(--lens-transition-fast);
      }

      .filter-btn:hover {
        background: var(--lens-bg-hover);
      }

      .filter-btn.active {
        border-color: var(--lens-text-secondary);
        color: var(--lens-text);
      }

      .feed {
        flex: 1;
        overflow-y: auto;
        position: relative;
      }

      .event-row {
        display: grid;
        grid-template-columns: 72px 1fr;
        padding: 4px 12px;
        font-size: 11px;
        line-height: 1.5;
        transition: background var(--lens-transition-fast);
      }

      .event-row:hover {
        background: var(--lens-bg-hover);
      }

      .event-row:nth-child(even) {
        background: rgba(255, 255, 255, 0.01);
      }

      .event-row:nth-child(even):hover {
        background: var(--lens-bg-hover);
      }

      .event-row.flash {
        animation: event-flash 0.5s ease-out;
      }

      @keyframes event-flash {
        from { background: var(--lens-accent-dim); }
        to { background: transparent; }
      }

      .time {
        color: var(--lens-text-dim);
        font-size: 10px;
        padding-top: 1px;
      }

      .body {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        align-items: baseline;
      }

      .action {
        font-weight: 500;
      }

      .agent {
        font-size: 10px;
        color: var(--lens-text-dim);
      }

      .message {
        color: var(--lens-text-secondary);
        flex-basis: 100%;
      }

      .message.command-detail {
        background: rgba(255, 255, 255, 0.03);
        border: 1px solid var(--lens-border);
        border-radius: 3px;
        padding: 3px 6px;
        font-size: 10px;
        color: var(--lens-amber);
        white-space: pre-wrap;
        word-break: break-all;
        margin-top: 2px;
      }

      .jump-btn {
        position: absolute;
        bottom: 12px;
        left: 50%;
        transform: translateX(-50%);
        padding: 4px 12px;
        font-family: var(--lens-font-mono);
        font-size: 10px;
        color: var(--lens-accent);
        background: var(--lens-bg-elevated);
        border: 1px solid var(--lens-border);
        border-radius: var(--lens-radius-md);
        cursor: pointer;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
        transition: opacity var(--lens-transition-fast);
        z-index: 10;
      }

      .jump-btn:hover {
        background: var(--lens-bg-hover);
      }

      .hidden {
        display: none;
      }
    `,
  ];

  @property({ type: Array }) events: LensEvent[] = [];
  @property({ type: Array }) activeFilters: string[] = [...EVENT_TYPES];

  @state() private _showJump = false;

  @query(".feed") private _feed!: HTMLElement;

  private _onScroll() {
    if (!this._feed) return;
    const { scrollTop, scrollHeight, clientHeight } = this._feed;
    this._showJump = scrollHeight - scrollTop - clientHeight > 60;
  }

  private _jumpToLatest() {
    if (this._feed) {
      this._feed.scrollTop = this._feed.scrollHeight;
      this._showJump = false;
    }
  }

  private _toggleFilter(type: string) {
    const idx = this.activeFilters.indexOf(type);
    if (idx >= 0) {
      this.activeFilters = this.activeFilters.filter((t) => t !== type);
    } else {
      this.activeFilters = [...this.activeFilters, type];
    }
    this.dispatchEvent(
      new CustomEvent("filter-toggle", { detail: { type }, bubbles: true, composed: true })
    );
  }

  private get _filteredEvents(): LensEvent[] {
    return this.events.filter((e) => this.activeFilters.includes(e.action));
  }

  protected override render() {
    const filtered = this._filteredEvents;

    return html`
      <div class="header">Events</div>
      <div class="filters">
        ${EVENT_TYPES.map(
          (type) => html`
            <button
              class="filter-btn ${this.activeFilters.includes(type) ? "active" : ""}"
              @click=${() => this._toggleFilter(type)}
            >
              ${type}
            </button>
          `
        )}
      </div>
      <div class="feed" @scroll=${this._onScroll}>
        ${repeat(
          filtered,
          (e, i) => `${e.timestamp}-${e.action}-${i}`,
          (e) => {
            const isCommand = e.action === "command";
            const colonIdx = isCommand ? e.message.indexOf(": ") : -1;
            const toolName = colonIdx > 0 ? e.message.slice(0, colonIdx) : "";
            const toolDetail = colonIdx > 0 ? e.message.slice(colonIdx + 2) : "";

            return html`
              <div class="event-row">
                <span class="time">${formatTime(e.timestamp)}</span>
                <div class="body">
                  <span class="action" style="color: ${actionColors[e.action] || "var(--lens-text)"}">${e.action}</span>
                  ${e.agentName ? html`<span class="agent">${e.agentName}</span>` : nothing}
                  ${isCommand && toolDetail
                    ? html`
                      <span class="message">${toolName}</span>
                      <span class="message command-detail">${toolDetail}</span>
                    `
                    : html`<span class="message">${e.message}</span>`
                  }
                </div>
              </div>
            `;
          }
        )}
        <button
          class="jump-btn ${this._showJump ? "" : "hidden"}"
          @click=${this._jumpToLatest}
        >
          Jump to latest
        </button>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "lens-event-feed": LensEventFeed;
  }
}
