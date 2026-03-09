import { html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { LensElement, lensBaseStyles } from "../tokens/base.js";
import type { LensBBEntry, LensProcess } from "../mock/types.js";

// ── Syntax highlighting for JSON values ─────────────────────────

function highlightJson(value: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);

  if (value === null) return `<span class="j-null">null</span>`;
  if (typeof value === "boolean") return `<span class="j-bool">${value}</span>`;
  if (typeof value === "number") return `<span class="j-num">${value}</span>`;
  if (typeof value === "string") {
    const escaped = value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    // Multiline strings: show as block
    if (escaped.includes("\n")) {
      const lines = escaped.split("\n").map(l => `${pad}  <span class="j-str">${l}</span>`).join("\n");
      return `<span class="j-str-block">\n${lines}\n${pad}</span>`;
    }
    return `<span class="j-str">"${escaped}"</span>`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return `<span class="j-bracket">[]</span>`;
    const items = value.map(v => `${pad}  ${highlightJson(v, indent + 1)}`).join(",\n");
    return `<span class="j-bracket">[</span>\n${items}\n${pad}<span class="j-bracket">]</span>`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length === 0) return `<span class="j-bracket">{}</span>`;
    const entries = keys.map(k => {
      const v = (value as Record<string, unknown>)[k];
      return `${pad}  <span class="j-key">"${k}"</span>: ${highlightJson(v, indent + 1)}`;
    }).join(",\n");
    return `<span class="j-bracket">{</span>\n${entries}\n${pad}<span class="j-bracket">}</span>`;
  }
  return String(value);
}

// ── Namespace colors ────────────────────────────────────────────

const NS_COLORS: Record<string, string> = {
  "system": "#666",
  "result": "#00ff88",
  "ephemeral": "#00d4ff",
  "_inbox": "#ff8844",
  "consolidation": "#b388ff",
  "scope": "#ffb020",
};

function nsColor(ns: string): string {
  return NS_COLORS[ns] ?? "#888";
}

// ── Tree node structure ─────────────────────────────────────────

interface TreeNode {
  label: string;
  fullKey?: string;       // only set on leaf nodes (actual BB entries)
  children: TreeNode[];
  namespace: string;      // top-level namespace for coloring
  count: number;          // total leaf descendants
}

function buildTree(keys: string[]): TreeNode[] {
  const root: TreeNode = { label: "", children: [], namespace: "", count: 0 };

  for (const key of keys) {
    const parts = key.split(":");
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLeaf = i === parts.length - 1;
      let child = current.children.find(c => c.label === part && !c.fullKey);

      if (isLeaf) {
        // Always add leaf nodes
        current.children.push({
          label: part,
          fullKey: key,
          children: [],
          namespace: parts[0],
          count: 1,
        });
      } else {
        if (!child) {
          child = { label: part, children: [], namespace: parts[0], count: 0 };
          current.children.push(child);
        }
        current = child;
      }
    }
  }

  // Propagate counts up
  function countLeaves(node: TreeNode): number {
    if (node.fullKey) return 1;
    let total = 0;
    for (const child of node.children) {
      total += countLeaves(child);
    }
    node.count = total;
    return total;
  }
  countLeaves(root);

  // Collapse single-child branches (e.g., "result" with one child becomes "result:child")
  function collapse(node: TreeNode): TreeNode {
    node.children = node.children.map(collapse);
    if (!node.fullKey && node.children.length === 1 && !node.children[0].fullKey) {
      const child = node.children[0];
      return {
        label: `${node.label}:${child.label}`,
        children: child.children,
        namespace: node.namespace,
        count: child.count,
      };
    }
    return node;
  }

  root.children = root.children.map(collapse);
  return root.children;
}

// ── Component ───────────────────────────────────────────────────

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

      /* ── Left panel: tree view ── */

      .left-panel {
        width: 280px;
        border-right: 1px solid var(--lens-border);
        display: flex;
        flex-direction: column;
        flex-shrink: 0;
      }

      .toolbar {
        display: flex;
        align-items: center;
        border-bottom: 1px solid var(--lens-border);
        gap: 0;
      }

      .search {
        flex: 1;
        padding: 8px 12px;
        font-family: var(--lens-font-mono);
        font-size: 11px;
        background: var(--lens-bg-surface);
        border: none;
        color: var(--lens-text);
        outline: none;
      }

      .search:focus {
        background: var(--lens-bg-active);
      }

      .search::placeholder {
        color: var(--lens-text-dim);
      }

      .view-toggle {
        display: flex;
        padding: 0 6px;
        gap: 2px;
        background: var(--lens-bg-surface);
        height: 100%;
        align-items: center;
      }

      .view-btn {
        border: none;
        background: none;
        color: var(--lens-text-dim);
        font-family: var(--lens-font-mono);
        font-size: 10px;
        padding: 4px 8px;
        cursor: pointer;
        border-radius: 2px;
        transition: all 100ms;
      }

      .view-btn:hover { color: var(--lens-text); }
      .view-btn.active {
        color: var(--lens-accent);
        background: var(--lens-bg-active);
      }

      .key-list {
        flex: 1;
        overflow-y: auto;
        padding: 4px 0;
      }

      /* ── Tree nodes ── */

      .tree-group {
        user-select: none;
      }

      .tree-header {
        display: flex;
        align-items: center;
        padding: 4px 8px 4px 0;
        cursor: pointer;
        transition: background 100ms;
        gap: 4px;
      }

      .tree-header:hover {
        background: var(--lens-bg-hover);
      }

      .tree-chevron {
        width: 16px;
        flex-shrink: 0;
        text-align: center;
        font-size: 8px;
        color: var(--lens-text-dim);
        transition: transform 150ms;
      }

      .tree-chevron.open {
        transform: rotate(90deg);
      }

      .tree-ns-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        flex-shrink: 0;
        margin-right: 6px;
      }

      .tree-label {
        font-size: 11px;
        color: var(--lens-text-secondary);
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .tree-count {
        font-size: 9px;
        color: var(--lens-text-dim);
        background: var(--lens-bg-surface);
        padding: 1px 5px;
        border-radius: 8px;
        flex-shrink: 0;
      }

      .tree-children {
        overflow: hidden;
      }

      /* ── Leaf key items ── */

      .key-item {
        display: flex;
        align-items: center;
        padding: 5px 10px;
        border-left: 2px solid transparent;
        cursor: pointer;
        transition: all 80ms;
        gap: 6px;
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
        flex: 1;
      }

      .key-writer {
        font-size: 9px;
        color: var(--lens-text-dim);
        flex-shrink: 0;
        max-width: 80px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .key-ns-bar {
        width: 3px;
        height: 14px;
        border-radius: 1px;
        flex-shrink: 0;
      }

      /* ── Right panel: detail view ── */

      .right-panel {
        flex: 1;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
      }

      .detail-header {
        padding: 12px 16px;
        border-bottom: 1px solid var(--lens-border);
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .detail-key {
        font-size: 13px;
        font-weight: 600;
        color: var(--lens-text);
        word-break: break-all;
      }

      .detail-meta {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        font-size: 10px;
        color: var(--lens-text-dim);
      }

      .meta-item {
        display: flex;
        align-items: center;
        gap: 4px;
      }

      .meta-label {
        color: var(--lens-text-dim);
      }

      .meta-value {
        color: var(--lens-text-secondary);
      }

      .meta-tag {
        display: inline-block;
        padding: 1px 6px;
        border-radius: 3px;
        font-size: 9px;
        background: var(--lens-bg-surface);
        color: var(--lens-text-secondary);
        border: 1px solid var(--lens-border);
      }

      .meta-tag.writer {
        border-color: rgba(0,255,136,0.2);
        color: var(--lens-green);
      }

      .meta-tag.reader {
        border-color: rgba(0,212,255,0.2);
        color: var(--lens-cyan);
      }

      .detail-body {
        flex: 1;
        padding: 12px 16px;
        overflow-y: auto;
      }

      .copy-btn {
        border: 1px solid var(--lens-border);
        background: var(--lens-bg-surface);
        color: var(--lens-text-dim);
        font-family: var(--lens-font-mono);
        font-size: 9px;
        padding: 3px 8px;
        cursor: pointer;
        border-radius: 2px;
        transition: all 100ms;
      }

      .copy-btn:hover {
        color: var(--lens-text);
        border-color: var(--lens-border-bright);
      }

      .copy-btn.copied {
        color: var(--lens-green);
        border-color: rgba(0,255,136,0.3);
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
      pre .j-str-block { color: var(--lens-green); opacity: 0.85; }
      pre .j-num { color: var(--lens-cyan); }
      pre .j-bool { color: var(--lens-magenta); }
      pre .j-null { color: var(--lens-gray); }
      pre .j-bracket { color: var(--lens-text-dim); }

      /* ── Value type indicator ── */
      .value-type {
        font-size: 9px;
        color: var(--lens-text-dim);
        padding: 2px 6px;
        background: var(--lens-bg-surface);
        border-radius: 2px;
        margin-left: auto;
      }
    `,
  ];

  @property({ type: Object }) entries: Record<string, LensBBEntry> = {};
  @property({ type: Array }) processes: LensProcess[] = [];
  @property({ type: String }) selectedKey = "";

  @state() private _searchQuery = "";
  @state() private _viewMode: "tree" | "flat" = "tree";
  @state() private _collapsed = new Set<string>();
  @state() private _copied = false;

  private get _filteredKeys(): string[] {
    const keys = Object.keys(this.entries).sort();
    if (!this._searchQuery) return keys;
    const q = this._searchQuery.toLowerCase();
    return keys.filter(k => k.toLowerCase().includes(q));
  }

  private _selectKey(key: string) {
    this.selectedKey = key;
    this._copied = false;
    this.dispatchEvent(new CustomEvent("key-select", { detail: { key }, bubbles: true, composed: true }));
  }

  private _onSearch(e: Event) {
    this._searchQuery = (e.target as HTMLInputElement).value;
  }

  private _toggleGroup(path: string) {
    const next = new Set(this._collapsed);
    if (next.has(path)) {
      next.delete(path);
    } else {
      next.add(path);
    }
    this._collapsed = next;
  }

  private _copyValue() {
    const entry = this.entries[this.selectedKey];
    if (!entry) return;
    const text = typeof entry.value === "string" ? entry.value : JSON.stringify(entry.value, null, 2);
    navigator.clipboard.writeText(text).then(() => {
      this._copied = true;
      setTimeout(() => { this._copied = false; this.requestUpdate(); }, 1500);
      this.requestUpdate();
    });
  }

  private _valueType(value: unknown): string {
    if (value === null) return "null";
    if (Array.isArray(value)) return `array[${value.length}]`;
    if (typeof value === "object") return `object{${Object.keys(value as object).length}}`;
    return typeof value;
  }

  // ── Render tree nodes recursively ──────────────────────────────

  private _renderTreeNode(node: TreeNode, depth: number, pathPrefix: string) {
    const path = pathPrefix ? `${pathPrefix}:${node.label}` : node.label;
    const indent = depth * 16 + 8;

    // Leaf node — an actual blackboard entry
    if (node.fullKey) {
      const entry = this.entries[node.fullKey];
      return html`
        <div
          class="key-item ${this.selectedKey === node.fullKey ? "active" : ""}"
          style="padding-left: ${indent}px"
          @click=${() => this._selectKey(node.fullKey!)}
        >
          <span class="key-ns-bar" style="background: ${nsColor(node.namespace)}"></span>
          <span class="key-name">${node.label}</span>
          <span class="key-writer">${entry?.writer ?? ""}</span>
        </div>
      `;
    }

    // Branch node — collapsible group
    const isCollapsed = this._collapsed.has(path);

    return html`
      <div class="tree-group">
        <div class="tree-header" style="padding-left: ${indent}px" @click=${() => this._toggleGroup(path)}>
          <span class="tree-chevron ${isCollapsed ? "" : "open"}">&#9654;</span>
          <span class="tree-ns-dot" style="background: ${nsColor(node.namespace)}"></span>
          <span class="tree-label">${node.label}</span>
          <span class="tree-count">${node.count}</span>
        </div>
        ${isCollapsed ? nothing : html`
          <div class="tree-children">
            ${node.children.map(child => this._renderTreeNode(child, depth + 1, path))}
          </div>
        `}
      </div>
    `;
  }

  // ── Render flat key list ───────────────────────────────────────

  private _renderFlatKey(key: string) {
    const entry = this.entries[key];
    const ns = key.split(":")[0];
    return html`
      <div
        class="key-item ${this.selectedKey === key ? "active" : ""}"
        @click=${() => this._selectKey(key)}
      >
        <span class="key-ns-bar" style="background: ${nsColor(ns)}"></span>
        <span class="key-name">${key}</span>
        <span class="key-writer">${entry?.writer ?? ""}</span>
      </div>
    `;
  }

  // ── Render detail panel ────────────────────────────────────────

  private _renderDetail() {
    const entry = this.entries[this.selectedKey];
    if (!entry) {
      return html`<div class="empty-state">Select a key to inspect</div>`;
    }

    const ns = this.selectedKey.split(":")[0];
    const vType = this._valueType(entry.value);

    return html`
      <div class="detail-header">
        <div style="display:flex;align-items:center;gap:8px">
          <span class="key-ns-bar" style="background:${nsColor(ns)};width:4px;height:18px"></span>
          <span class="detail-key">${this.selectedKey}</span>
          <span class="value-type">${vType}</span>
        </div>
        <div class="detail-meta">
          <span class="meta-item">
            <span class="meta-label">writer</span>
            <span class="meta-tag writer">${entry.writer}</span>
          </span>
          ${entry.tick != null ? html`
            <span class="meta-item">
              <span class="meta-label">tick</span>
              <span class="meta-value">${entry.tick}</span>
            </span>
          ` : nothing}
          ${entry.readBy && entry.readBy.length > 0 ? html`
            <span class="meta-item">
              <span class="meta-label">read by</span>
              ${entry.readBy.map(r => html`<span class="meta-tag reader">${r}</span>`)}
            </span>
          ` : nothing}
          <button class="copy-btn ${this._copied ? "copied" : ""}" @click=${this._copyValue}>
            ${this._copied ? "copied" : "copy"}
          </button>
        </div>
      </div>
      <div class="detail-body">
        <pre .innerHTML=${highlightJson(entry.value)}></pre>
      </div>
    `;
  }

  protected override render() {
    const keys = this._filteredKeys;
    const tree = this._viewMode === "tree" ? buildTree(keys) : [];

    return html`
      <div class="left-panel">
        <div class="toolbar">
          <input
            class="search"
            type="text"
            placeholder="Filter keys..."
            .value=${this._searchQuery}
            @input=${this._onSearch}
          />
          <div class="view-toggle">
            <button
              class="view-btn ${this._viewMode === "tree" ? "active" : ""}"
              @click=${() => { this._viewMode = "tree"; }}
              title="Tree view"
            >&#9660;</button>
            <button
              class="view-btn ${this._viewMode === "flat" ? "active" : ""}"
              @click=${() => { this._viewMode = "flat"; }}
              title="Flat list"
            >&#9776;</button>
          </div>
        </div>
        <div class="key-list">
          ${keys.length === 0
            ? html`<div class="empty-state" style="height:auto;padding:24px">No keys</div>`
            : this._viewMode === "tree"
              ? tree.map(node => this._renderTreeNode(node, 0, ""))
              : keys.map(key => this._renderFlatKey(key))
          }
        </div>
      </div>
      <div class="right-panel">
        ${this._renderDetail()}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "lens-blackboard": LensBlackboard;
  }
}
