import { html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { LensElement, lensBaseStyles } from "../tokens/base.js";
import type { LensMetrics } from "../mock/types.js";

@customElement("lens-metrics-bar")
export class LensMetricsBar extends LensElement {
  static override styles = [
    lensBaseStyles,
    css`
      :host {
        display: inline-flex;
        align-items: center;
        gap: 16px;
        font-family: var(--lens-font-mono);
        font-size: 10px;
        color: var(--lens-text-dim);
      }

      .value {
        color: var(--lens-text-secondary);
      }
    `,
  ];

  @property({ attribute: false }) metrics?: LensMetrics;

  private _fmt(n: number): string {
    return n >= 1000 ? n.toLocaleString() : String(n);
  }

  protected override render() {
    if (!this.metrics) return html``;

    const m = this.metrics;
    return html`
      <span><span class="value">${m.processCount}</span> processes</span>
      <span><span class="value">${m.runningCount}</span> running</span>
      <span><span class="value">${this._fmt(m.totalTokens)}</span> tokens</span>
      <span>tick <span class="value">${m.tickCount}</span></span>
      <span>~<span class="value">${m.tokenRate}</span> tok/s</span>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "lens-metrics-bar": LensMetricsBar;
  }
}
