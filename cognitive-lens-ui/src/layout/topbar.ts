import { html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { LensElement, lensBaseStyles } from "../tokens/base.js";

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
        padding: 0 16px;
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

  private _onRunSelect() {
    this.dispatchEvent(new CustomEvent("run-select", { bubbles: true, composed: true }));
  }

  protected override render() {
    return html`
      <span class="brand">${this.brandName}</span>
      <button class="run-selector" @click=${this._onRunSelect}>
        ${this.runLabel || "Select run..."}
      </button>
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
