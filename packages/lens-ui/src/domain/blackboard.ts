import { html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { LensElement, lensBaseStyles } from "../tokens/base.js";
import type { LensBBEntry } from "../mock/types.js";

function highlightJson(value: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);

  if (value === null) {
    return `<span class="j-null">null</span>`;
  }
  if (typeof value === "boolean") {
    return `<span class="j-bool">${value}</span>`;
  }
  if (typeof value === "number") {
    return `<span class="j-num">${value}</span>`;
  }
  if (typeof value === "string") {
    const escaped = value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return `<span class="j-str">"${escaped}"</span>`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return `<span class="j-bracket">[]</span>`;
    const items = value
      .map((v) => `${pad}  ${highlightJson(v, indent + 1)}`)
      .join(",\n");
    return `<span class="j-bracket">[</span>\n${items}\n${pad}<span class="j-bracket">]</span>`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length === 0) return `<span class="j-bracket">{}</span>`;
    const entries = keys
      .map((k) => {
        const v = (value as Record<string, unknown>)[k];
        return `${pad}  <span class="j-key">"${k}"</span>: ${highlightJson(v, indent + 1)}`;
      })
      .join(",\n");
    return `<span class="j-bracket">{</span>\n${entries}\n${pad}<span class="j-bracket">}</span>`;
  }
  return String(value);
}

@customElement("lens-blackboard")
export class LensBlackboard extends LensElement {
  static override styles = [
    lensBaseStyles,
    css`
      :host {
        display: flex;
        flex-direction: row;
        height: 100%;
        font-family: var(--lens-font-mono);
        background: var(--lens-bg-panel);
      }

      .left-panel {
        width: 260px;
        border-right: 1px solid var(--lens-border);
        display: flex;
        flex-direction: column;
        flex-shrink: 0;
      }

      .search {
        width: 100%;
        padding: 8px 12px;
        font-family: var(--lens-font-mono);
        font-size: 11px;
        background: var(--lens-bg-surface);
        border: none;
        border-bottom: 1px solid var(--lens-border);
        color: var(--lens-text);
        outline: none;
      }

      .search:focus {
        border-bottom-color: var(--lens-accent);
      }

      .search::placeholder {
        color: var(--lens-text-dim);
      }

      .key-list {
        flex: 1;
        overflow-y: auto;
      }

      .key-item {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 6px 12px;
        border-left: 2px solid transparent;
        cursor: pointer;
        transition: all var(--lens-transition-fast);
      }

      .key-item:hover {
        background: var(--lens-bg-hover);
      }

      .key-item.active {
        border-left-color: var(--lens-accent);
        background: var(--lens-bg-active);
      }

      .key-name {
        font-size: 11px;
        color: var(--lens-text);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .key-writer {
        font-size: 9px;
        color: var(--lens-text-dim);
        flex-shrink: 0;
        margin-left: 8px;
      }

      .right-panel {
        flex: 1;
        overflow-y: auto;
        padding: 12px 16px;
      }

      .empty-state {
        display: flex;
        align-items: center;
        justify-content: center;
        height: 100%;
        color: var(--lens-text-dim);
        font-size: 12px;
      }

      pre {
        font-family: var(--lens-font-mono);
        font-size: 11px;
        line-height: 1.6;
        white-space: pre-wrap;
        word-break: break-word;
        margin: 0;
      }

      pre .j-key { color: #e0e0e0; }
      pre .j-str { color: var(--lens-green); }
      pre .j-num { color: var(--lens-cyan); }
      pre .j-bool { color: var(--lens-magenta); }
      pre .j-null { color: var(--lens-gray); }
      pre .j-bracket { color: var(--lens-text-dim); }
    `,
  ];

  @property({ type: Object }) entries: Record<string, LensBBEntry> = {};
  @property({ type: String }) selectedKey = "";

  @state() private _searchQuery = "";

  private get _filteredKeys(): string[] {
    const keys = Object.keys(this.entries);
    if (!this._searchQuery) return keys;
    const q = this._searchQuery.toLowerCase();
    return keys.filter((k) => k.toLowerCase().includes(q));
  }

  private _selectKey(key: string) {
    this.selectedKey = key;
    this.dispatchEvent(
      new CustomEvent("key-select", { detail: { key }, bubbles: true, composed: true })
    );
  }

  private _onSearch(e: Event) {
    const query = (e.target as HTMLInputElement).value;
    this._searchQuery = query;
    this.dispatchEvent(
      new CustomEvent("search", { detail: { query }, bubbles: true, composed: true })
    );
  }

  protected override render() {
    const keys = this._filteredKeys;
    const selected = this.entries[this.selectedKey];

    return html`
      <div class="left-panel">
        <input
          class="search"
          type="text"
          placeholder="Search keys..."
          .value=${this._searchQuery}
          @input=${this._onSearch}
        />
        <div class="key-list">
          ${keys.map(
            (key) => html`
              <div
                class="key-item ${this.selectedKey === key ? "active" : ""}"
                @click=${() => this._selectKey(key)}
              >
                <span class="key-name">${key}</span>
                <span class="key-writer">${this.entries[key].writer}</span>
              </div>
            `
          )}
        </div>
      </div>
      <div class="right-panel">
        ${selected
          ? html`<pre .innerHTML=${highlightJson(selected.value)}></pre>`
          : html`<div class="empty-state">Select a key to inspect its value</div>`}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "lens-blackboard": LensBlackboard;
  }
}
