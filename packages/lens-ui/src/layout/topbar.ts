import { html, css, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { LensElement, lensBaseStyles } from "../tokens/base.js";
import type { RunStatus } from "../mock/types.js";

@customElement("lens-topbar")
export class LensTopbar extends LensElement {
  static override styles = [
    lensBaseStyles,
    css`
      :host {
        display: flex;
        align-items: center;
        justify-content: space-between;
        height: 40px;
        padding: 0 20px;
        border-bottom: 1px solid var(--lens-border);
        background: var(--lens-bg-panel);
      }

      .brand {
        font-family: var(--lens-font-mono);
        font-size: 12px;
        font-weight: 500;
        color: var(--lens-text-dim);
        letter-spacing: 0.5px;
        text-transform: uppercase;
      }

      .center {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .run-selector {
        font-family: var(--lens-font-mono);
        font-size: 12px;
        color: var(--lens-text);
        background: var(--lens-bg-surface);
        border: 1px solid var(--lens-border);
        padding: 4px 12px;
        cursor: pointer;
        transition: border-color var(--lens-transition-fast);
      }

      .run-selector:hover {
        border-color: var(--lens-border-bright);
      }

      .run-btn {
        font-family: var(--lens-font-mono);
        font-size: 10px;
        padding: 3px 10px;
        border: 1px solid var(--lens-border);
        border-radius: var(--lens-radius-sm);
        background: transparent;
        cursor: pointer;
        transition: all var(--lens-transition-fast);
      }

      .run-btn:hover {
        border-color: var(--lens-border-bright);
      }

      .run-btn.cancel {
        color: var(--lens-red);
        border-color: rgba(255,68,68,0.3);
      }
      .run-btn.cancel:hover {
        background: var(--lens-red-dim);
        border-color: var(--lens-red);
      }

      .run-btn.pause {
        color: var(--lens-amber);
        border-color: rgba(255,176,32,0.3);
      }
      .run-btn.pause:hover {
        background: var(--lens-amber-dim);
        border-color: var(--lens-amber);
      }

      .run-btn.resume {
        color: var(--lens-green);
        border-color: rgba(0,255,136,0.3);
      }
      .run-btn.resume:hover {
        background: var(--lens-green-dim);
        border-color: var(--lens-green);
      }

      .status-area {
        display: flex;
        align-items: center;
        gap: 12px;
        font-family: var(--lens-font-mono);
        font-size: 11px;
        color: var(--lens-text-secondary);
      }

      .conn-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        flex-shrink: 0;
      }

      .conn-dot.connected {
        background: var(--lens-green);
        box-shadow: 0 0 4px var(--lens-green);
        animation: pulse-dot 2s ease-in-out infinite;
      }

      .conn-dot.disconnected {
        background: var(--lens-red);
      }

      @keyframes pulse-dot {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.5; }
      }
    `,
  ];

  @property() brandName = "Cognitive Lens";
  @property() runLabel = "";
  @property() elapsed = "00:00";
  @property({ type: Boolean }) connected = false;
  @property() runStatus: RunStatus | "" = "";

  private _onRunSelect() {
    this.dispatchEvent(new CustomEvent("run-select", { bubbles: true, composed: true }));
  }

  private _onCancel() {
    this.dispatchEvent(new CustomEvent("cancel-run-request", { bubbles: true, composed: true }));
  }

  private _onPause() {
    this.dispatchEvent(new CustomEvent("pause-run-request", { bubbles: true, composed: true }));
  }

  private _onResume() {
    this.dispatchEvent(new CustomEvent("resume-run-request", { bubbles: true, composed: true }));
  }

  protected override render() {
    const isRunning = this.runStatus === "running";
    const isPaused = this.runStatus === "paused";
    const isActive = isRunning || isPaused;

    return html`
      <span class="brand">${this.brandName}</span>
      <div class="center">
        <button class="run-selector" @click=${this._onRunSelect}>
          ${this.runLabel || "Select run..."}
        </button>
        ${isActive ? html`
          ${isRunning ? html`
            <button class="run-btn pause" @click=${this._onPause} title="Pause run">Pause</button>
          ` : html`
            <button class="run-btn resume" @click=${this._onResume} title="Resume run">Resume</button>
          `}
          <button class="run-btn cancel" @click=${this._onCancel} title="Cancel run">Cancel</button>
        ` : nothing}
      </div>
      <div class="status-area">
        <span class="conn-dot ${this.connected ? "connected" : "disconnected"}"></span>
        <span>${this.elapsed}</span>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "lens-topbar": LensTopbar;
  }
}
