import { html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { LensElement, lensBaseStyles } from "../tokens/base.js";
import type { ConnectionStatus } from "../mock/types.js";

const labels: Record<ConnectionStatus, string> = {
  connected: "live",
  reconnecting: "reconnecting...",
  disconnected: "disconnected",
};

@customElement("lens-connection-badge")
export class LensConnectionBadge extends LensElement {
  static override styles = [
    lensBaseStyles,
    css`
      :host {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-family: var(--lens-font-mono);
        font-size: 11px;
      }

      .dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        flex-shrink: 0;
      }

      :host([status="connected"]) .dot {
        background: var(--lens-green);
        box-shadow: 0 0 6px var(--lens-green);
        animation: pulse 2s ease-in-out infinite;
      }

      :host([status="reconnecting"]) .dot {
        background: var(--lens-amber);
      }

      :host([status="disconnected"]) .dot {
        background: var(--lens-red);
      }

      :host([status="connected"]) .label { color: var(--lens-green); }
      :host([status="reconnecting"]) .label { color: var(--lens-amber); }
      :host([status="disconnected"]) .label { color: var(--lens-red); }

      @keyframes pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.4; }
      }
    `,
  ];

  @property({ reflect: true }) status: ConnectionStatus = "disconnected";

  protected override render() {
    return html`
      <span class="dot"></span>
      <span class="label">${labels[this.status]}</span>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "lens-connection-badge": LensConnectionBadge;
  }
}
