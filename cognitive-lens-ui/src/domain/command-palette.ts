import { html, css, nothing } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import { LensElement, lensBaseStyles } from "../tokens/base.js";

export interface CommandSuggestion {
  icon: string;
  label: string;
}

@customElement("lens-command-palette")
export class LensCommandPalette extends LensElement {
  static override styles = [
    lensBaseStyles,
    css`
      :host {
        display: contents;
      }

      .overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.7);
        backdrop-filter: blur(2px);
        z-index: 1000;
        display: flex;
        align-items: flex-start;
        justify-content: center;
        padding-top: 20vh;
      }

      .card {
        width: 560px;
        max-height: 60vh;
        background: var(--lens-bg-panel);
        border: 1px solid var(--lens-border-bright);
        border-radius: var(--lens-radius-md);
        display: flex;
        flex-direction: column;
        overflow: hidden;
        animation: palette-in 0.15s ease-out;
      }

      @keyframes palette-in {
        from {
          transform: translateY(-8px) scale(0.98);
          opacity: 0;
        }
        to {
          transform: translateY(0) scale(1);
          opacity: 1;
        }
      }

      .input-area {
        border-bottom: 1px solid var(--lens-border);
      }

      .input-area input {
        width: 100%;
        background: var(--lens-bg-surface);
        border: none;
        font-family: var(--lens-font-mono);
        font-size: 14px;
        color: var(--lens-text);
        padding: 14px 16px;
        outline: none;
      }

      .input-area input::placeholder {
        color: var(--lens-text-dim);
      }

      .suggestions {
        padding: 4px 0;
        overflow-y: auto;
      }

      .suggestion {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 8px 16px;
        font-family: var(--lens-font-mono);
        font-size: 12px;
        color: var(--lens-text-secondary);
        cursor: pointer;
        transition: background var(--lens-transition-fast), color var(--lens-transition-fast);
      }

      .suggestion:hover {
        background: var(--lens-bg-hover);
        color: var(--lens-text);
      }

      .suggestion .icon {
        color: var(--lens-accent);
        flex-shrink: 0;
        width: 16px;
        text-align: center;
      }

      .response {
        border-top: 1px solid var(--lens-border);
        padding: 16px;
        font-family: var(--lens-font-mono);
        font-size: 12px;
        color: var(--lens-text-secondary);
        display: none;
      }
    `,
  ];

  @property({ type: Boolean }) open = false;
  @property({ attribute: false }) suggestions: CommandSuggestion[] = [];

  @query("input") private _input!: HTMLInputElement;

  private _onOverlayClick(e: Event) {
    if (e.target === e.currentTarget) {
      this.dispatchEvent(new CustomEvent("close", { bubbles: true, composed: true }));
    }
  }

  private _onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      this.dispatchEvent(new CustomEvent("close", { bubbles: true, composed: true }));
    }
  }

  private _onInput() {
    this.dispatchEvent(
      new CustomEvent("query", {
        detail: this._input.value,
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _onSelect(index: number) {
    this.dispatchEvent(
      new CustomEvent("select", {
        detail: index,
        bubbles: true,
        composed: true,
      }),
    );
  }

  protected override updated(changed: Map<string, unknown>) {
    if (changed.has("open") && this.open) {
      requestAnimationFrame(() => this._input?.focus());
    }
  }

  protected override render() {
    if (!this.open) return nothing;

    return html`
      <div class="overlay" @click=${this._onOverlayClick} @keydown=${this._onKeyDown}>
        <div class="card">
          <div class="input-area">
            <input
              type="text"
              placeholder="Type a command..."
              @input=${this._onInput}
              @keydown=${this._onKeyDown}
            />
          </div>
          ${this.suggestions.length > 0
            ? html`
                <div class="suggestions">
                  ${this.suggestions.map(
                    (s, i) => html`
                      <div class="suggestion" @click=${() => this._onSelect(i)}>
                        <span class="icon">${s.icon}</span>
                        <span>${s.label}</span>
                      </div>
                    `,
                  )}
                </div>
              `
            : nothing}
          <div class="response"></div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "lens-command-palette": LensCommandPalette;
  }
}
