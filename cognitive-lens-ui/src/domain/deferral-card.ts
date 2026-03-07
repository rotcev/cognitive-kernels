import { html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { LensElement, lensBaseStyles } from "../tokens/base.js";
import type { LensDeferral } from "../mock/types.js";

@customElement("lens-deferral-card")
export class LensDeferralCard extends LensElement {
  static override styles = [
    lensBaseStyles,
    css`
      :host {
        display: block;
      }

      .card {
        border: 1px solid var(--lens-border);
        border-radius: var(--lens-radius-md);
        padding: 12px 16px;
      }

      .top-row {
        display: flex;
        align-items: center;
        gap: 10px;
      }

      .name {
        font-family: var(--lens-font-mono);
        font-size: 12px;
        font-weight: 500;
        color: var(--lens-amber);
      }

      .condition {
        font-family: var(--lens-font-mono);
        font-size: 11px;
        color: var(--lens-text-secondary);
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .waited {
        font-family: var(--lens-font-mono);
        font-size: 10px;
        color: var(--lens-text-dim);
        flex-shrink: 0;
        margin-left: auto;
      }

      .waited.stale {
        color: var(--lens-red);
      }

      .reason {
        font-family: var(--lens-font-mono);
        font-size: 11px;
        color: var(--lens-text-dim);
        font-style: italic;
        padding-left: 4px;
        margin-top: 6px;
        line-height: 1.5;
      }
    `,
  ];

  @property({ attribute: false }) deferral?: LensDeferral;

  protected override render() {
    if (!this.deferral) return html``;

    const d = this.deferral;
    const isStale = d.waitedTicks > 10;
    const conditionStr = `${d.conditionType}: ${d.conditionKey}`;

    return html`
      <div class="card">
        <div class="top-row">
          <span class="name">${d.name}</span>
          <span class="condition">${conditionStr}</span>
          <span class="waited ${isStale ? "stale" : ""}">${d.waitedTicks} ticks</span>
        </div>
        <div class="reason">${d.reason}</div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "lens-deferral-card": LensDeferralCard;
  }
}
