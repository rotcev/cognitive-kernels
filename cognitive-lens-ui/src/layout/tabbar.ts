import { html, css, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { LensElement, lensBaseStyles } from "../tokens/base.js";

export interface TabDef {
  id: string;
  label: string;
}

@customElement("lens-tabbar")
export class LensTabbar extends LensElement {
  static override styles = [
    lensBaseStyles,
    css`
      :host {
        display: flex;
        border-bottom: 1px solid var(--lens-border);
        background: var(--lens-bg-panel);
        padding: 0 8px;
        flex-shrink: 0;
      }

      button {
        font-family: var(--lens-font-mono);
        color: var(--lens-text-dim);
        cursor: pointer;
        border: none;
        border-bottom: 2px solid transparent;
        background: none;
        transition: all var(--lens-transition-fast);
      }

      button:hover {
        color: var(--lens-text-secondary);
      }

      button.active {
        color: var(--lens-accent);
        border-bottom-color: var(--lens-accent);
      }

      /* Center variant (default) */
      :host([variant="center"]) button,
      :host(:not([variant])) button {
        font-size: 11px;
        padding: 8px 14px;
      }

      /* Drawer variant */
      :host([variant="drawer"]) button {
        font-size: 10px;
        padding: 7px 12px;
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }
    `,
  ];

  @property({ type: Array }) tabs: TabDef[] = [];
  @property({ reflect: true }) activeTab = "";
  @property({ reflect: true }) variant: "center" | "drawer" = "center";

  private _onTabClick(tabId: string) {
    this.dispatchEvent(
      new CustomEvent("tab-change", {
        detail: { tab: tabId },
        bubbles: true,
        composed: true,
      })
    );
  }

  protected override render() {
    if (!this.tabs.length) return nothing;
    return html`
      ${this.tabs.map(
        (t) => html`
          <button
            class=${t.id === this.activeTab ? "active" : ""}
            @click=${() => this._onTabClick(t.id)}
          >
            ${t.label}
          </button>
        `
      )}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "lens-tabbar": LensTabbar;
  }
}
