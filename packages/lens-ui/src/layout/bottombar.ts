import { html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { LensElement, lensBaseStyles } from "../tokens/base.js";
import type { LensMetrics } from "../mock/types.js";

@customElement("lens-bottombar")
export class LensBottombar extends LensElement {
  static override styles = [
    lensBaseStyles,
    css`
      :host {
        display: flex;
        align-items: center;
        justify-content: space-between;
        height: 32px;
        padding: 0 20px;
        border-top: 1px solid var(--lens-border);
        background: var(--lens-bg-panel);
        font-family: var(--lens-font-mono);
        font-size: 10px;
        color: var(--lens-text-dim);
      }

      .stats {
        display: flex;
        gap: 16px;
      }

      .stat span {
        color: var(--lens-text-secondary);
      }

      .shortcuts {
        display: flex;
        gap: 12px;
      }

      .shortcut kbd {
        background: var(--lens-bg-elevated);
        border: 1px solid var(--lens-border);
        padding: 1px 5px;
        font-family: var(--lens-font-mono);
        font-size: 9px;
        margin-right: 3px;
        border-radius: var(--lens-radius-sm);
      }
    `,
  ];

  @property({ type: Object }) metrics: LensMetrics = {
    totalTokens: 0,
    tokenRate: 0,
    processCount: 0,
    runningCount: 0,
    sleepingCount: 0,
    deadCount: 0,
    checkpointedCount: 0,
    suspendedCount: 0,
    dagDepth: 0,
    dagEdgeCount: 0,
    wallTimeElapsedMs: 0,
    tickCount: 0,
  };

  private _formatTokens(n: number): string {
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
  }

  protected override render() {
    const m = this.metrics;
    return html`
      <div class="stats">
        <span class="stat"><span>${m.processCount}</span> processes</span>
        <span class="stat"><span>${m.runningCount}</span> running</span>
        <span class="stat"><span>${this._formatTokens(m.totalTokens)}</span> tokens</span>
        <span class="stat">tick <span>${m.tickCount}</span></span>
        <span class="stat">~<span>${m.tokenRate}</span> tok/s</span>
      </div>
      <div class="shortcuts">
        <span class="shortcut"><kbd>\u2318K</kbd> Command</span>
        <span class="shortcut"><kbd>Tab</kbd> Navigate</span>
        <span class="shortcut"><kbd>Esc</kbd> Back</span>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "lens-bottombar": LensBottombar;
  }
}
