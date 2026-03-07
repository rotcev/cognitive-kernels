import { html, css } from "lit";
import { customElement } from "lit/decorators.js";
import { LensElement, lensBaseStyles } from "../tokens/base.js";

@customElement("lens-panel")
export class LensPanel extends LensElement {
  static override styles = [
    lensBaseStyles,
    css`
      :host {
        display: block;
        background: var(--lens-bg-panel);
        border: 1px solid var(--lens-border);
      }

      .header {
        padding: 10px 12px 8px;
        border-bottom: 1px solid var(--lens-border);
      }

      ::slotted([slot="header"]) {
        font-family: var(--lens-font-mono);
        font-size: 10px;
        font-weight: 500;
        text-transform: uppercase;
        letter-spacing: 1px;
        color: var(--lens-text-dim);
      }

      .header-label {
        font-family: var(--lens-font-mono);
        font-size: 10px;
        font-weight: 500;
        text-transform: uppercase;
        letter-spacing: 1px;
        color: var(--lens-text-dim);
      }

      .body {
        padding: 0;
      }
    `,
  ];

  protected override render() {
    return html`
      <div class="header">
        <slot name="header"></slot>
      </div>
      <div class="body">
        <slot></slot>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "lens-panel": LensPanel;
  }
}
