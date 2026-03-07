import { html, css } from "lit";
import { customElement } from "lit/decorators.js";
import { LensElement, lensBaseStyles } from "../tokens/base.js";

@customElement("lens-split-layout")
export class LensSplitLayout extends LensElement {
  static override styles = [
    lensBaseStyles,
    css`
      :host {
        display: grid;
        grid-template-rows: var(--lens-topbar-h) var(--lens-narrative-h) 1fr var(--lens-bottombar-h);
        grid-template-columns: var(--lens-sidebar-w) 1fr var(--lens-rightpanel-w);
        height: 100vh;
        overflow: hidden;
        position: relative;
        background: var(--lens-bg-root);
      }

      :host::after {
        content: '';
        position: fixed;
        inset: 0;
        pointer-events: none;
        z-index: 9998;
        background: repeating-linear-gradient(
          0deg,
          transparent,
          transparent 2px,
          rgba(0,0,0,0.03) 2px,
          rgba(0,0,0,0.03) 4px
        );
        mix-blend-mode: multiply;
      }

      ::slotted([slot="topbar"]) {
        grid-column: 1 / -1;
        grid-row: 1;
      }

      ::slotted([slot="narrative"]) {
        grid-column: 1 / -1;
        grid-row: 2;
      }

      ::slotted([slot="sidebar"]) {
        grid-row: 3;
        grid-column: 1;
      }

      ::slotted([slot="center"]) {
        grid-row: 3;
        grid-column: 2;
      }

      ::slotted([slot="right"]) {
        grid-row: 3;
        grid-column: 3;
      }

      ::slotted([slot="bottombar"]) {
        grid-column: 1 / -1;
        grid-row: 4;
      }
    `,
  ];

  override createRenderRoot() {
    return this;
  }

  protected override render() {
    return html`
      <style>
        lens-split-layout {
          display: grid;
          grid-template-rows: var(--lens-topbar-h, 40px) var(--lens-narrative-h, 36px) 1fr var(--lens-bottombar-h, 32px);
          grid-template-columns: var(--lens-sidebar-w, 280px) 1fr var(--lens-rightpanel-w, 360px);
          height: 100vh;
          overflow: hidden;
          position: relative;
          background: var(--lens-bg-root, #000);
        }

        lens-split-layout::after {
          content: '';
          position: fixed;
          inset: 0;
          pointer-events: none;
          z-index: 9998;
          background: repeating-linear-gradient(
            0deg,
            transparent,
            transparent 2px,
            rgba(0,0,0,0.03) 2px,
            rgba(0,0,0,0.03) 4px
          );
          mix-blend-mode: multiply;
        }

        lens-split-layout [slot="topbar"] {
          grid-column: 1 / -1;
          grid-row: 1;
        }

        lens-split-layout [slot="narrative"] {
          grid-column: 1 / -1;
          grid-row: 2;
        }

        lens-split-layout [slot="sidebar"] {
          grid-row: 3;
          grid-column: 1;
        }

        lens-split-layout [slot="center"] {
          grid-row: 3;
          grid-column: 2;
        }

        lens-split-layout [slot="right"] {
          grid-row: 3;
          grid-column: 3;
        }

        lens-split-layout [slot="bottombar"] {
          grid-column: 1 / -1;
          grid-row: 4;
        }
      </style>
      <slot name="topbar"></slot>
      <slot name="narrative"></slot>
      <slot name="sidebar"></slot>
      <slot name="center"></slot>
      <slot name="right"></slot>
      <slot name="bottombar"></slot>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "lens-split-layout": LensSplitLayout;
  }
}
