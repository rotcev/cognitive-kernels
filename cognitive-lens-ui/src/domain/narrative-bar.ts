import { html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { LensElement, lensBaseStyles } from "../tokens/base.js";

@customElement("lens-narrative-bar")
export class LensNarrativeBar extends LensElement {
  static override styles = [
    lensBaseStyles,
    css`
      :host {
        display: flex;
        flex-direction: row;
        align-items: center;
        gap: 8px;
        height: 36px;
        padding: 0 12px;
        border-bottom: 1px solid var(--lens-border);
        background: var(--lens-bg-panel);
        font-family: var(--lens-font-mono);
        font-size: 11px;
        color: var(--lens-text-secondary);
        overflow: hidden;
      }

      .cursor {
        color: var(--lens-accent);
        font-weight: 600;
        flex-shrink: 0;
        animation: blink 1s step-end infinite;
      }

      .text {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        transition: opacity 0.4s ease;
      }

      @keyframes blink {
        0%, 100% { opacity: 1; }
        50% { opacity: 0; }
      }
    `,
  ];

  @property() text = "";

  protected override render() {
    return html`
      <span class="cursor">&gt;</span>
      <span class="text">${this.text}</span>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "lens-narrative-bar": LensNarrativeBar;
  }
}
