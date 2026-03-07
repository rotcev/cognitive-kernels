import { html, css, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { LensElement, lensBaseStyles } from "../tokens/base.js";
import type { LensProcess } from "../mock/types.js";

@customElement("lens-expanded-view")
export class LensExpandedView extends LensElement {
  static styles = [
    lensBaseStyles,
    css`
      :host { display: contents; }

      .overlay {
        position: fixed;
        inset: 0;
        background: var(--lens-bg-root);
        z-index: 900;
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }

      .topbar {
        height: 44px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0 20px;
        border-bottom: 1px solid var(--lens-border);
        background: var(--lens-bg-panel);
        flex-shrink: 0;
      }

      .title {
        display: flex;
        align-items: center;
        gap: 10px;
      }

      .title h2 {
        font-family: var(--lens-font-mono);
        font-size: 15px;
        font-weight: 600;
        color: var(--lens-accent);
      }

      .state-badge {
        font-family: var(--lens-font-mono);
        font-size: 10px;
        font-weight: 500;
        padding: 1px 6px;
        border-radius: var(--lens-radius-sm);
      }

      .role-badge {
        font-family: var(--lens-font-mono);
        font-size: 9px;
        padding: 1px 5px;
        letter-spacing: 0.3px;
        font-weight: 500;
        border: 1px solid;
      }

      .close-btn {
        background: none;
        border: 1px solid var(--lens-border);
        color: var(--lens-text-dim);
        cursor: pointer;
        padding: 4px 12px;
        font-family: var(--lens-font-mono);
        font-size: 11px;
        transition: all var(--lens-transition-fast);
        display: flex;
        align-items: center;
        gap: 6px;
      }

      .close-btn:hover {
        color: var(--lens-text);
        border-color: var(--lens-border-bright);
      }

      .close-btn kbd {
        background: var(--lens-bg-elevated);
        border: 1px solid var(--lens-border);
        padding: 1px 4px;
        font-size: 9px;
        font-family: var(--lens-font-mono);
      }

      .meta {
        padding: 16px 20px;
        border-bottom: 1px solid var(--lens-border);
        display: flex;
        gap: 32px;
        flex-wrap: wrap;
        background: var(--lens-bg-panel);
      }

      .meta-item {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .meta-label {
        font-family: var(--lens-font-mono);
        font-size: 9px;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        color: var(--lens-text-dim);
      }

      .meta-value {
        font-family: var(--lens-font-mono);
        font-size: 12px;
        color: var(--lens-text);
      }

      .body {
        flex: 1;
        display: grid;
        grid-template-columns: 1fr 1fr;
        overflow: hidden;
      }

      .pane {
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }

      .pane:first-child {
        border-right: 1px solid var(--lens-border);
      }

      .pane-header {
        padding: 8px 16px;
        border-bottom: 1px solid var(--lens-border);
        font-family: var(--lens-font-mono);
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.8px;
        color: var(--lens-text-dim);
        background: var(--lens-bg-panel);
        flex-shrink: 0;
      }

      .pane-body {
        flex: 1;
        overflow-y: auto;
        padding: 12px 16px;
        font-family: var(--lens-font-mono);
        font-size: 11px;
        line-height: 1.6;
        color: var(--lens-text-secondary);
        white-space: pre-wrap;
        word-break: break-word;
      }

      .placeholder {
        color: var(--lens-text-dim);
        padding: 20px;
        text-align: center;
      }

      .token-bar {
        height: 4px;
        background: var(--lens-bg-elevated);
        margin-top: 4px;
        border-radius: 1px;
        overflow: hidden;
      }

      .token-bar-fill {
        height: 100%;
        background: var(--lens-accent);
        transition: width var(--lens-transition-med);
      }
    `,
  ];

  @property({ type: Object }) process: LensProcess | null = null;
  @property({ type: Boolean, reflect: true }) open = false;

  private _stateColor(state: string): { color: string; bg: string } {
    const map: Record<string, { color: string; bg: string }> = {
      running: { color: "var(--lens-green)", bg: "var(--lens-green-dim)" },
      sleeping: { color: "var(--lens-amber)", bg: "var(--lens-amber-dim)" },
      idle: { color: "var(--lens-amber)", bg: "var(--lens-amber-dim)" },
      dead: { color: "var(--lens-gray)", bg: "var(--lens-gray-dim)" },
      checkpoint: { color: "var(--lens-blue)", bg: "var(--lens-blue-dim)" },
      suspended: { color: "var(--lens-red)", bg: "var(--lens-red-dim)" },
    };
    return map[state] ?? { color: "var(--lens-gray)", bg: "var(--lens-gray-dim)" };
  }

  private _roleStyle(role: string): string {
    const map: Record<string, string> = {
      kernel: "color:var(--lens-accent);background:var(--lens-accent-dim);border-color:rgba(0,255,136,0.15)",
      "sub-kernel": "color:var(--lens-cyan);background:var(--lens-cyan-dim);border-color:rgba(0,212,255,0.15)",
      worker: "color:var(--lens-text-secondary);background:var(--lens-bg-elevated);border-color:var(--lens-border)",
      shell: "color:var(--lens-text-secondary);background:var(--lens-gray-dim);border-color:var(--lens-border)",
    };
    return map[role] ?? map.worker;
  }

  render() {
    if (!this.open || !this.process) return nothing;
    const p = this.process;
    const sc = this._stateColor(p.state);
    const tokenPct = p.tokenBudget ? Math.min(100, (p.tokensUsed / p.tokenBudget) * 100) : 0;

    return html`
      <div class="overlay">
        <div class="topbar">
          <div class="title">
            <h2>${p.name}</h2>
            <span class="role-badge" style="${this._roleStyle(p.role)}">${p.role}</span>
            <span class="state-badge" style="color:${sc.color};background:${sc.bg}">${p.state}</span>
          </div>
          <button class="close-btn" @click=${this._close}><kbd>Esc</kbd> Close</button>
        </div>

        <div class="meta">
          <div class="meta-item">
            <span class="meta-label">PID</span>
            <span class="meta-value">${p.pid}</span>
          </div>
          <div class="meta-item">
            <span class="meta-label">Model</span>
            <span class="meta-value">${p.model}</span>
          </div>
          <div class="meta-item">
            <span class="meta-label">Priority</span>
            <span class="meta-value">${p.priority}</span>
          </div>
          <div class="meta-item">
            <span class="meta-label">Ticks</span>
            <span class="meta-value">${p.tickCount}</span>
          </div>
          <div class="meta-item">
            <span class="meta-label">Tokens</span>
            <span class="meta-value">
              ${p.tokensUsed.toLocaleString()}${p.tokenBudget ? ` / ${p.tokenBudget.toLocaleString()}` : ""}
            </span>
            ${p.tokenBudget ? html`
              <div class="token-bar">
                <div class="token-bar-fill" style="width:${tokenPct}%"></div>
              </div>
            ` : nothing}
          </div>
          <div class="meta-item">
            <span class="meta-label">Objective</span>
            <span class="meta-value">${p.objective}</span>
          </div>
        </div>

        <div class="body">
          <div class="pane">
            <div class="pane-header">Terminal Output</div>
            <div class="pane-body">
              <slot name="terminal">
                <div class="placeholder">Terminal output for ${p.name}</div>
              </slot>
            </div>
          </div>
          <div class="pane">
            <div class="pane-header">Blackboard I/O</div>
            <div class="pane-body">
              <slot name="blackboard">
                <div class="placeholder">Blackboard entries for ${p.name}</div>
              </slot>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  private _close() {
    this.dispatchEvent(new CustomEvent("close", { bubbles: true, composed: true }));
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
    if (e.key === "Escape" && this.open) this._close();
  }
}
