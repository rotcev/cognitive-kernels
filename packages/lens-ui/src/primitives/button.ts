import { html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { LensElement, lensBaseStyles } from "../tokens/base.js";

@customElement("lens-button")
export class LensButton extends LensElement {
  static override styles = [
    lensBaseStyles,
    css`
      :host {
        display: inline-flex;
      }

      button {
        cursor: pointer;
        font-family: var(--lens-font-mono);
        border: none;
        background: none;
        color: var(--lens-text-dim);
        transition: all var(--lens-transition-fast);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        white-space: nowrap;
      }

      button:disabled {
        opacity: 0.4;
        cursor: not-allowed;
        pointer-events: none;
      }

      /* ── Filter variant ── */
      :host([variant="filter"]) button {
        font-size: 10px;
        padding: 3px 8px;
        background: transparent;
        border: 1px solid transparent;
        color: var(--lens-text-dim);
      }
      :host([variant="filter"]) button:hover {
        color: var(--lens-text-secondary);
      }
      :host([variant="filter"][active]) button {
        color: var(--lens-accent);
        border-color: var(--lens-accent);
        background: var(--lens-accent-dim);
      }

      /* ── Tab variant ── */
      :host([variant="tab"]) button {
        font-size: 11px;
        padding: 8px 14px;
        color: var(--lens-text-dim);
        border-bottom: 2px solid transparent;
      }
      :host([variant="tab"]) button:hover {
        color: var(--lens-text-secondary);
      }
      :host([variant="tab"][active]) button {
        color: var(--lens-accent);
        border-bottom-color: var(--lens-accent);
      }

      /* ── Action variant ── */
      :host([variant="action"]) button {
        font-size: 10px;
        padding: 0 12px;
        height: 32px;
        background: var(--lens-accent-dim);
        border: 1px solid rgba(0, 255, 136, 0.2);
        color: var(--lens-accent);
      }
      :host([variant="action"]) button:hover {
        background: rgba(0, 255, 136, 0.25);
      }

      /* ── Close variant ── */
      :host([variant="close"]) button {
        width: 24px;
        height: 24px;
        font-size: 14px;
        border: 1px solid var(--lens-border);
        color: var(--lens-text-dim);
        background: none;
      }
      :host([variant="close"]) button:hover {
        color: var(--lens-text);
        border-color: var(--lens-border-bright);
      }
    `,
  ];

  @property({ reflect: true }) variant: "filter" | "tab" | "action" | "close" = "filter";
  @property({ type: Boolean, reflect: true }) active = false;
  @property({ type: Boolean, reflect: true }) disabled = false;

  protected override render() {
    if (this.variant === "close") {
      return html`<button ?disabled=${this.disabled} @click=${this._handleClick}>\u00D7</button>`;
    }
    return html`<button ?disabled=${this.disabled} @click=${this._handleClick}><slot></slot></button>`;
  }

  private _handleClick(e: Event) {
    if (this.disabled) {
      e.stopPropagation();
      e.preventDefault();
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "lens-button": LensButton;
  }
}
