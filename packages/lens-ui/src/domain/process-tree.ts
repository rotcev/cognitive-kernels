import { html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { LensElement, lensBaseStyles } from "../tokens/base.js";
import type { LensProcess, LensProcessRole } from "../mock/types.js";

type ProcessState = "running" | "spawned" | "sleeping" | "idle" | "dead" | "checkpoint" | "suspended";

interface TreeNode {
  process: LensProcess;
  children: TreeNode[];
  depth: number;
}

const stateColors: Record<ProcessState, { fg: string; bg: string }> = {
  running: { fg: "var(--lens-green)", bg: "var(--lens-green-dim)" },
  spawned: { fg: "var(--lens-green)", bg: "var(--lens-green-dim)" },
  sleeping: { fg: "var(--lens-amber)", bg: "var(--lens-amber-dim)" },
  idle: { fg: "var(--lens-text-dim)", bg: "var(--lens-gray-dim)" },
  dead: { fg: "var(--lens-gray)", bg: "var(--lens-gray-dim)" },
  checkpoint: { fg: "var(--lens-blue)", bg: "var(--lens-blue-dim)" },
  suspended: { fg: "var(--lens-magenta)", bg: "var(--lens-magenta-dim)" },
};

const roleColors: Record<LensProcessRole, { fg: string; bg: string; border: string }> = {
  kernel: { fg: "var(--lens-accent)", bg: "var(--lens-accent-dim)", border: "var(--lens-accent)" },
  "sub-kernel": { fg: "var(--lens-cyan)", bg: "var(--lens-cyan-dim)", border: "var(--lens-cyan)" },
  worker: { fg: "var(--lens-gray)", bg: "var(--lens-gray-dim)", border: "var(--lens-gray)" },
  shell: { fg: "var(--lens-gray)", bg: "var(--lens-gray-dim)", border: "var(--lens-gray)" },
};

@customElement("lens-process-tree")
export class LensProcessTree extends LensElement {
  static override styles = [
    lensBaseStyles,
    css`
      :host {
        display: block;
        font-family: var(--lens-font-mono);
        overflow-y: auto;
      }

      .node-row {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 4px 8px;
        cursor: pointer;
        transition: background var(--lens-transition-fast);
      }

      .node-row:hover {
        background: var(--lens-bg-hover);
      }

      .node-row.selected {
        background: var(--lens-bg-active);
      }

      .node-row.flash {
        animation: spawn-flash 0.6s ease-out;
      }

      @keyframes spawn-flash {
        from { background: var(--lens-accent-dim); }
        to { background: transparent; }
      }

      .toggle {
        width: 14px;
        height: 14px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 10px;
        color: var(--lens-text-dim);
        cursor: pointer;
        transition: transform var(--lens-transition-fast);
        flex-shrink: 0;
        user-select: none;
      }

      .toggle.collapsed {
        transform: rotate(-90deg);
      }

      .toggle.empty {
        visibility: hidden;
      }

      .name {
        font-size: 12px;
        font-weight: 500;
        color: var(--lens-text);
      }

      .name.dead {
        color: var(--lens-text-dim);
      }

      .state-badge {
        font-size: 10px;
        padding: 1px 6px;
        border-radius: var(--lens-radius-sm);
        line-height: 1.4;
      }

      .role-badge {
        font-size: 9px;
        padding: 1px 5px;
        border-radius: var(--lens-radius-sm);
        border-width: 1px;
        border-style: solid;
        line-height: 1.4;
      }

      .tokens {
        margin-left: auto;
        font-size: 11px;
        color: var(--lens-text-dim);
        flex-shrink: 0;
      }

      .tokens.dead {
        opacity: 0.5;
      }

      .children {
        overflow: hidden;
        max-height: 2000px;
        transition: max-height 0.3s ease;
      }

      .children.collapsed {
        max-height: 0;
      }
    `,
  ];

  @property({ type: Array }) processes: LensProcess[] = [];
  @property({ type: String }) selectedPid = "";

  @state() private _collapsed = new Set<string>();

  private _buildTree(): TreeNode[] {
    const byPid = new Map<string, LensProcess>();
    for (const p of this.processes) byPid.set(p.pid, p);

    const roots: TreeNode[] = [];

    const build = (proc: LensProcess, depth: number): TreeNode => {
      const children = this.processes
        .filter((p) => p.parentPid === proc.pid)
        .map((p) => build(p, depth + 1));
      return { process: proc, children, depth };
    };

    for (const p of this.processes) {
      if (!p.parentPid) {
        roots.push(build(p, 0));
      }
    }
    return roots;
  }

  private _toggleCollapse(pid: string) {
    const next = new Set(this._collapsed);
    if (next.has(pid)) next.delete(pid);
    else next.add(pid);
    this._collapsed = next;
    this.dispatchEvent(
      new CustomEvent("process-expand", { detail: { pid }, bubbles: true, composed: true })
    );
  }

  private _selectProcess(pid: string) {
    this.dispatchEvent(
      new CustomEvent("process-select", { detail: { pid }, bubbles: true, composed: true })
    );
  }

  private _renderNode(node: TreeNode): unknown {
    const p = node.process;
    const hasChildren = node.children.length > 0;
    const isCollapsed = this._collapsed.has(p.pid);
    const sc = stateColors[p.state as ProcessState] ?? stateColors.idle;
    const rc = roleColors[p.role];

    return html`
      <div
        class="node-row ${this.selectedPid === p.pid ? "selected" : ""}"
        style="padding-left: ${node.depth * 20 + 8}px"
        @click=${() => this._selectProcess(p.pid)}
      >
        <span
          class="toggle ${hasChildren ? (isCollapsed ? "collapsed" : "") : "empty"}"
          @click=${(e: Event) => {
            e.stopPropagation();
            if (hasChildren) this._toggleCollapse(p.pid);
          }}
        >${hasChildren ? "\u25BE" : ""}</span>
        <span class="name ${p.state === "dead" ? "dead" : ""}">${p.name}</span>
        <span class="state-badge" style="color: ${sc.fg}; background: ${sc.bg};">${p.state}</span>
        <span class="role-badge" style="color: ${rc.fg}; background: ${rc.bg}; border-color: ${rc.border};">${p.role}</span>
        <span class="tokens ${p.state === "dead" ? "dead" : ""}">${p.tokensUsed.toLocaleString()} tok</span>
      </div>
      ${hasChildren
        ? html`<div class="children ${isCollapsed ? "collapsed" : ""}">
            ${node.children.map((c) => this._renderNode(c))}
          </div>`
        : nothing}
    `;
  }

  protected override render() {
    const tree = this._buildTree();
    return html`${tree.map((n) => this._renderNode(n))}`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "lens-process-tree": LensProcessTree;
  }
}
