import { html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { LensElement, lensBaseStyles } from "../tokens/base.js";

export interface TooltipLine {
  label: string;
  value: string;
}

@customElement("lens-tooltip")
export class LensTooltip extends LensElement {
  static override styles = [
    lensBaseStyles,
    css`
      :host {
        position: fixed;
        z-index: 500;
        pointer-events: none;
        display: none;
      }

      :host([open]) {
        display: block;
      }

      .tooltip {
        background: var(--lens-bg-elevated);
        border: 1px solid var(--lens-border-bright);
        padding: 8px 12px;
        font-family: var(--lens-font-mono);
        font-size: 10px;
        max-width: 320px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
      }

      .line {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        padding: 2px 0;
      }

      .label {
        color: var(--lens-text-dim);
        white-space: nowrap;
      }

      .value {
        color: var(--lens-text);
        text-align: right;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
    `,
  ];

  @property({ type: Boolean, reflect: true }) open = false;
  @property({ type: Number }) x = 0;
  @property({ type: Number }) y = 0;
  @property({ type: Array }) lines: TooltipLine[] = [];

  protected override updated() {
    this.style.left = `${this.x}px`;
    this.style.top = `${this.y}px`;
  }

  protected override render() {
    return html`
      <div class="tooltip">
        ${this.lines.map(
          (line) => html`
            <div class="line">
              <span class="label">${line.label}</span>
              <span class="value">${line.value}</span>
            </div>
          `
        )}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "lens-tooltip": LensTooltip;
  }
}
