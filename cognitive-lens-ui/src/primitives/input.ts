import { html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { LensElement, lensBaseStyles } from "../tokens/base.js";

@customElement("lens-input")
export class LensInput extends LensElement {
  static override styles = [
    lensBaseStyles,
    css`
      :host {
        display: block;
      }

      input,
      textarea {
        width: 100%;
        background: var(--lens-bg-surface);
        border: 1px solid var(--lens-border);
        color: var(--lens-text);
        font-family: var(--lens-font-mono);
        font-size: 11px;
        padding: 4px 8px;
        outline: none;
        transition: border-color var(--lens-transition-fast);
      }

      input:focus,
      textarea:focus {
        border-color: var(--lens-accent);
      }

      input::placeholder,
      textarea::placeholder {
        color: var(--lens-text-dim);
      }

      input:disabled,
      textarea:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }

      textarea {
        resize: none;
        height: 32px;
      }
    `,
  ];

  @property({ reflect: true }) variant: "text" | "search" | "textarea" = "text";
  @property() value = "";
  @property() placeholder = "";
  @property({ type: Boolean }) disabled = false;

  protected override render() {
    if (this.variant === "textarea") {
      return html`
        <textarea
          .value=${this.value}
          placeholder=${this.placeholder}
          ?disabled=${this.disabled}
          @input=${this._onInput}
          @change=${this._onChange}
        ></textarea>
      `;
    }

    return html`
      <input
        type="text"
        .value=${this.value}
        placeholder=${this.variant === "search" && !this.placeholder ? "Filter..." : this.placeholder}
        ?disabled=${this.disabled}
        @input=${this._onInput}
        @change=${this._onChange}
      />
    `;
  }

  private _onInput(e: Event) {
    const target = e.target as HTMLInputElement | HTMLTextAreaElement;
    this.value = target.value;
    this.dispatchEvent(new CustomEvent("input", { detail: { value: this.value }, bubbles: true, composed: true }));
  }

  private _onChange(e: Event) {
    const target = e.target as HTMLInputElement | HTMLTextAreaElement;
    this.value = target.value;
    this.dispatchEvent(new CustomEvent("change", { detail: { value: this.value }, bubbles: true, composed: true }));
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "lens-input": LensInput;
  }
}
