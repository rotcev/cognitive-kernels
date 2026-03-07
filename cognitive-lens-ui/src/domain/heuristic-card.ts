import { html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { LensElement, lensBaseStyles } from "../tokens/base.js";
import type { LensHeuristic } from "../mock/types.js";

@customElement("lens-heuristic-card")
export class LensHeuristicCard extends LensElement {
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
        transition: border-color var(--lens-transition-fast);
      }

      .card:hover {
        border-color: var(--lens-border-bright);
      }

      .top-row {
        display: flex;
        align-items: flex-start;
        gap: 10px;
      }

      .confidence {
        font-family: var(--lens-font-mono);
        font-size: 12px;
        font-weight: 600;
        color: var(--lens-accent);
        background: var(--lens-accent-dim);
        padding: 1px 6px;
        border-radius: var(--lens-radius-sm);
        flex-shrink: 0;
      }

      .heuristic-text {
        font-family: var(--lens-font-mono);
        font-size: 12px;
        color: var(--lens-text);
        line-height: 1.5;
      }

      .meta-row {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-top: 8px;
        font-family: var(--lens-font-mono);
        font-size: 10px;
        color: var(--lens-text-dim);
      }

      .scope-badge {
        border: 1px solid var(--lens-border);
        border-radius: var(--lens-radius-sm);
        padding: 0 4px;
      }
    `,
  ];

  @property({ attribute: false }) heuristic?: LensHeuristic;

  protected override render() {
    if (!this.heuristic) return html``;

    const h = this.heuristic;
    return html`
      <div class="card">
        <div class="top-row">
          <span class="confidence">${h.confidence.toFixed(2)}</span>
          <span class="heuristic-text">${h.heuristic}</span>
        </div>
        <div class="meta-row">
          <span class="scope-badge">${h.scope}</span>
          <span>reinforced ${h.reinforcementCount}x</span>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "lens-heuristic-card": LensHeuristicCard;
  }
}
