import { html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { LensElement, lensBaseStyles } from "../tokens/base.js";
import type { LensDagNode, LensDagEdge } from "../mock/types.js";

@customElement("lens-dag-view")
export class LensDagView extends LensElement {
  static override styles = [
    lensBaseStyles,
    css`
      :host {
        display: block;
        flex: 1;
        position: relative;
        overflow: hidden;
      }

      .container {
        width: 100%;
        height: 100%;
        min-height: 320px;
        position: relative;
      }

      canvas {
        width: 100%;
        height: 100%;
        display: block;
      }

      .placeholder {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        font-family: var(--lens-font-mono);
        font-size: 12px;
        color: var(--lens-text-dim);
      }

      .legend {
        position: absolute;
        bottom: 12px;
        left: 12px;
        background: rgba(5, 5, 5, 0.85);
        border: 1px solid var(--lens-border);
        border-radius: var(--lens-radius-md);
        padding: 10px 14px;
        font-family: var(--lens-font-mono);
        font-size: 10px;
        color: var(--lens-text-dim);
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .legend-section-title {
        font-weight: 600;
        color: var(--lens-text-secondary);
        margin-bottom: 2px;
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }

      .legend-items {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .legend-item {
        display: flex;
        align-items: center;
        gap: 6px;
      }

      .legend-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        flex-shrink: 0;
      }

      .legend-dot.running { background: var(--lens-green); box-shadow: 0 0 4px var(--lens-green); }
      .legend-dot.sleeping { background: var(--lens-amber); }
      .legend-dot.checkpoint { background: var(--lens-blue); }
      .legend-dot.dead { background: var(--lens-gray); }
      .legend-dot.suspended { background: var(--lens-red); }

      .legend-dot.kernel {
        background: var(--lens-accent);
        box-shadow: 0 0 4px var(--lens-accent);
      }
      .legend-dot.sub-kernel {
        background: transparent;
        border: 1px solid var(--lens-cyan);
      }
      .legend-dot.shell { background: var(--lens-gray); }

      .legend-line {
        width: 16px;
        height: 0;
        flex-shrink: 0;
      }

      .legend-line.parent-child {
        border-top: 1px solid var(--lens-text-dim);
      }

      .legend-line.dependency {
        border-top: 1px dashed var(--lens-amber);
      }

      .controls {
        position: absolute;
        top: 12px;
        right: 12px;
        font-family: var(--lens-font-mono);
        font-size: 10px;
        color: var(--lens-text-dim);
        display: flex;
        align-items: center;
        gap: 6px;
      }

      .controls input[type="checkbox"] {
        accent-color: var(--lens-accent);
      }
    `,
  ];

  @property({ attribute: false }) nodes: LensDagNode[] = [];
  @property({ attribute: false }) edges: LensDagEdge[] = [];
  @property({ type: Boolean, attribute: "show-dead" }) showDead = false;

  private _onToggleDead(e: Event) {
    this.showDead = (e.target as HTMLInputElement).checked;
    this.dispatchEvent(new CustomEvent("show-dead-change", { detail: this.showDead, bubbles: true, composed: true }));
  }

  protected override render() {
    return html`
      <div class="container">
        <canvas></canvas>
        <div class="placeholder">DAG renderer not connected</div>

        <div class="controls">
          <input type="checkbox" id="show-dead" .checked=${this.showDead} @change=${this._onToggleDead} />
          <label for="show-dead">Show dead processes</label>
        </div>

        <div class="legend">
          <div>
            <div class="legend-section-title">Process State</div>
            <div class="legend-items">
              <div class="legend-item"><span class="legend-dot running"></span> Running</div>
              <div class="legend-item"><span class="legend-dot sleeping"></span> Sleeping</div>
              <div class="legend-item"><span class="legend-dot checkpoint"></span> Checkpoint</div>
              <div class="legend-item"><span class="legend-dot dead"></span> Dead</div>
              <div class="legend-item"><span class="legend-dot suspended"></span> Suspended</div>
            </div>
          </div>
          <div>
            <div class="legend-section-title">Process Type</div>
            <div class="legend-items">
              <div class="legend-item"><span class="legend-dot kernel"></span> Kernel</div>
              <div class="legend-item"><span class="legend-dot sub-kernel"></span> Sub-kernel</div>
              <div class="legend-item"><span class="legend-dot shell"></span> Shell</div>
            </div>
          </div>
          <div>
            <div class="legend-section-title">Edges</div>
            <div class="legend-items">
              <div class="legend-item"><span class="legend-line parent-child"></span> Parent-child</div>
              <div class="legend-item"><span class="legend-line dependency"></span> Dependency</div>
            </div>
          </div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "lens-dag-view": LensDagView;
  }
}
