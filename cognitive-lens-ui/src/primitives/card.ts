import { html, css } from "lit";
import { customElement } from "lit/decorators.js";
import { LensElement, lensBaseStyles } from "../tokens/base.js";

@customElement("lens-card")
export class LensCard extends LensElement {
  static override styles = [
    lensBaseStyles,
    css`
      :host {
        display: block;
        padding: 12px 16px;
        border: 1px solid var(--lens-border);
        transition: border-color var(--lens-transition-fast);
      }

      :host(:hover) {
        border-color: var(--lens-border-bright);
      }

      .header {
        margin-bottom: 6px;
      }

      ::slotted([slot="header"]) {
        font-family: var(--lens-font-mono);
        font-size: 12px;
        font-weight: 500;
        color: var(--lens-text);
      }
    `,
  ];

  protected override render() {
    return html`
      <div class="header">
        <slot name="header"></slot>
      </div>
      <slot></slot>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "lens-card": LensCard;
  }
}
