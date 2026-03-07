import { html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { LensElement, lensBaseStyles } from "../tokens/base.js";
import type { LensProcessRole } from "../mock/types.js";

type ProcessState = "running" | "sleeping" | "idle" | "dead" | "checkpoint" | "suspended";

@customElement("lens-badge")
export class LensBadge extends LensElement {
  static override styles = [
    lensBaseStyles,
    css`
      :host {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        font-family: var(--lens-font-mono);
        font-size: 10px;
        font-weight: 500;
        padding: 1px 6px;
        border-radius: var(--lens-radius-sm);
        white-space: nowrap;
        flex-shrink: 0;
      }

      /* ── State badges ── */
      :host([variant="state"][state="running"]) {
        color: var(--lens-green);
        background: var(--lens-green-dim);
      }
      :host([variant="state"][state="sleeping"]) {
        color: var(--lens-amber);
        background: var(--lens-amber-dim);
      }
      :host([variant="state"][state="idle"]) {
        color: var(--lens-amber);
        background: var(--lens-amber-dim);
      }
      :host([variant="state"][state="dead"]) {
        color: var(--lens-gray);
        background: var(--lens-gray-dim);
      }
      :host([variant="state"][state="checkpoint"]) {
        color: var(--lens-blue);
        background: var(--lens-blue-dim);
      }
      :host([variant="state"][state="suspended"]) {
        color: var(--lens-red);
        background: var(--lens-red-dim);
      }

      /* ── Role badges ── */
      :host([variant="role"]) {
        border: 1px solid var(--lens-border);
      }
      :host([variant="role"][role-type="kernel"]) {
        color: var(--lens-green);
        background: var(--lens-green-dim);
        border-color: var(--lens-green-dim);
      }
      :host([variant="role"][role-type="sub-kernel"]) {
        color: var(--lens-cyan);
        background: var(--lens-cyan-dim);
        border-color: var(--lens-cyan-dim);
      }
      :host([variant="role"][role-type="worker"]) {
        color: var(--lens-gray);
        background: var(--lens-gray-dim);
        border-color: var(--lens-gray-dim);
      }
      :host([variant="role"][role-type="shell"]) {
        color: var(--lens-gray);
        background: var(--lens-gray-dim);
        border-color: var(--lens-gray-dim);
      }

      .dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: currentColor;
        flex-shrink: 0;
      }

      :host([variant="state"][state="running"]) .dot {
        box-shadow: 0 0 4px var(--lens-green);
      }
    `,
  ];

  @property({ reflect: true }) variant: "state" | "role" = "state";
  @property({ reflect: true }) state?: ProcessState;
  @property({ attribute: "role-type", reflect: true }) roleType?: LensProcessRole;

  protected override render() {
    if (this.variant === "state" && this.state) {
      return html`<span class="dot"></span>${this.state}`;
    }
    if (this.variant === "role" && this.roleType) {
      return html`${this.roleType}`;
    }
    return html`<slot></slot>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "lens-badge": LensBadge;
  }
}
