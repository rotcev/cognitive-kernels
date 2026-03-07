import { html, css, nothing } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import { LensElement, lensBaseStyles } from "../tokens/base.js";
import type { LensTerminalLine, TerminalLevel } from "../mock/types.js";

const levelColors: Record<TerminalLevel, string> = {
  system: "var(--lens-amber)",
  info: "var(--lens-text-secondary)",
  thinking: "var(--lens-magenta)",
  tool: "var(--lens-cyan)",
  output: "var(--lens-green)",
  error: "var(--lens-red)",
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toTimeString().slice(0, 8);
}

@customElement("lens-terminal-view")
export class LensTerminalView extends LensElement {
  static override styles = [
    lensBaseStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        height: 100%;
        font-family: var(--lens-font-mono);
        background: var(--lens-bg-panel);
      }

      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 6px 12px;
        border-bottom: 1px solid var(--lens-border);
        font-size: 10px;
      }

      .header-left {
        display: flex;
        align-items: center;
        gap: 6px;
        color: var(--lens-text-dim);
      }

      .header-left .proc-name {
        color: var(--lens-text);
      }

      .header-right {
        display: flex;
        align-items: center;
        gap: 10px;
      }

      .autoscroll-label {
        display: flex;
        align-items: center;
        gap: 4px;
        font-size: 10px;
        color: var(--lens-text-dim);
        cursor: pointer;
      }

      .autoscroll-cb {
        appearance: none;
        width: 12px;
        height: 12px;
        border: 1px solid var(--lens-border-bright);
        border-radius: var(--lens-radius-sm);
        background: transparent;
        cursor: pointer;
        position: relative;
      }

      .autoscroll-cb:checked {
        border-color: var(--lens-accent);
        background: var(--lens-accent-dim);
      }

      .autoscroll-cb:checked::after {
        content: "";
        position: absolute;
        top: 1px;
        left: 3px;
        width: 4px;
        height: 7px;
        border: solid var(--lens-accent);
        border-width: 0 1.5px 1.5px 0;
        transform: rotate(45deg);
      }

      .clear-btn {
        font-family: var(--lens-font-mono);
        font-size: 10px;
        padding: 2px 8px;
        border: 1px solid var(--lens-border);
        border-radius: var(--lens-radius-sm);
        background: transparent;
        color: var(--lens-text-dim);
        cursor: pointer;
        transition: all var(--lens-transition-fast);
      }

      .clear-btn:hover {
        color: var(--lens-text);
        border-color: var(--lens-border-bright);
      }

      .output {
        flex: 1;
        overflow-y: auto;
        padding: 12px 16px;
        font-size: 11px;
        line-height: 1.6;
        white-space: pre-wrap;
        word-break: break-word;
      }

      .line {
        display: block;
        padding: 1px 0;
        transition: background var(--lens-transition-fast);
      }

      .line:hover {
        background: rgba(255, 255, 255, 0.02);
      }

      .line-ts {
        color: var(--lens-text-dim);
        font-size: 10px;
        margin-right: 8px;
        user-select: none;
      }

      .line-text.thinking {
        font-style: italic;
      }

      .cursor-prompt {
        display: inline-block;
        width: 7px;
        height: 13px;
        background: var(--lens-accent);
        animation: blink 1s step-end infinite;
        vertical-align: text-bottom;
        margin-left: 2px;
      }

      @keyframes blink {
        0%, 100% { opacity: 1; }
        50% { opacity: 0; }
      }

      .empty {
        display: flex;
        align-items: center;
        justify-content: center;
        height: 100%;
        color: var(--lens-text-dim);
        font-size: 12px;
      }
    `,
  ];

  @property({ type: Array }) lines: LensTerminalLine[] = [];
  @property({ type: Boolean }) autoscroll = true;
  @property({ type: String }) processFilter = "";

  @query(".output") private _output!: HTMLElement;

  protected override updated() {
    if (this.autoscroll && this._output) {
      this._output.scrollTop = this._output.scrollHeight;
    }
  }

  private get _filteredLines(): LensTerminalLine[] {
    if (!this.processFilter) return this.lines;
    return this.lines.filter((l) => l.pid === this.processFilter);
  }

  private _onAutoscrollChange(e: Event) {
    const enabled = (e.target as HTMLInputElement).checked;
    this.autoscroll = enabled;
    this.dispatchEvent(
      new CustomEvent("autoscroll-change", { detail: { enabled }, bubbles: true, composed: true })
    );
  }

  private _onClear() {
    this.dispatchEvent(new CustomEvent("clear", { bubbles: true, composed: true }));
  }

  private _processLabel(): string {
    if (!this.processFilter) return "all";
    const line = this.lines.find((l) => l.pid === this.processFilter);
    return line?.processName ?? this.processFilter;
  }

  protected override render() {
    const filtered = this._filteredLines;

    return html`
      <div class="header">
        <div class="header-left">
          <span>Process:</span>
          <span class="proc-name">${this._processLabel()}</span>
        </div>
        <div class="header-right">
          <label class="autoscroll-label">
            <input
              type="checkbox"
              class="autoscroll-cb"
              .checked=${this.autoscroll}
              @change=${this._onAutoscrollChange}
            />
            autoscroll
          </label>
          <button class="clear-btn" @click=${this._onClear}>Clear</button>
        </div>
      </div>
      ${filtered.length === 0
        ? html`<div class="empty">No output</div>`
        : html`
            <div class="output">
              ${filtered.map(
                (line) => html`
                  <span class="line">
                    <span class="line-ts">${formatTime(line.timestamp)}</span>
                    <span
                      class="line-text ${line.level === "thinking" ? "thinking" : ""}"
                      style="color: ${levelColors[line.level]}"
                    >${line.text}</span>
                  </span>
                `
              )}
              <span class="cursor-prompt"></span>
            </div>
          `}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "lens-terminal-view": LensTerminalView;
  }
}
