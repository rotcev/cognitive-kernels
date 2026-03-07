import { html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { LensElement, lensBaseStyles } from "../tokens/base.js";

export interface TableColumn {
  key: string;
  label: string;
}

@customElement("lens-table")
export class LensTable extends LensElement {
  static override styles = [
    lensBaseStyles,
    css`
      :host {
        display: block;
        font-family: var(--lens-font-mono);
        font-size: 12px;
      }

      table {
        width: 100%;
        border-collapse: collapse;
      }

      th {
        font-size: 9px;
        font-weight: 500;
        text-transform: uppercase;
        letter-spacing: 0.8px;
        color: var(--lens-text-dim);
        padding: 5px 8px;
        text-align: left;
        border-bottom: 1px solid var(--lens-border);
      }

      td {
        padding: 5px 8px;
        color: var(--lens-text);
        border-bottom: 1px solid var(--lens-border);
        font-size: 11px;
      }

      tr:hover td {
        background: var(--lens-bg-hover);
      }

      tr:last-child td {
        border-bottom: none;
      }
    `,
  ];

  @property({ type: Array }) columns: TableColumn[] = [];
  @property({ type: Array }) rows: Array<Record<string, string>> = [];

  // Support JSON string attributes
  override connectedCallback() {
    super.connectedCallback();
    this._parseJsonAttributes();
  }

  private _parseJsonAttributes() {
    const colAttr = this.getAttribute("columns");
    const rowAttr = this.getAttribute("rows");
    if (colAttr && typeof colAttr === "string") {
      try {
        this.columns = JSON.parse(colAttr);
      } catch {
        // ignore parse errors
      }
    }
    if (rowAttr && typeof rowAttr === "string") {
      try {
        this.rows = JSON.parse(rowAttr);
      } catch {
        // ignore parse errors
      }
    }
  }

  protected override render() {
    return html`
      <table>
        <thead>
          <tr>
            ${this.columns.map((col) => html`<th>${col.label}</th>`)}
          </tr>
        </thead>
        <tbody>
          ${this.rows.map(
            (row) => html`
              <tr>
                ${this.columns.map((col) => html`<td>${row[col.key] ?? ""}</td>`)}
              </tr>
            `
          )}
        </tbody>
      </table>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "lens-table": LensTable;
  }
}
