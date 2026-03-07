import { html, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { LensElement, lensBaseStyles } from "../tokens/base.js";
import type { LensDagNode, LensDagEdge } from "../mock/types.js";

interface NodePos {
  x: number;
  y: number;
}

const STATE_COLORS: Record<string, string> = {
  running: "#00ff88",
  spawned: "#00ff88",
  sleeping: "#ffb020",
  idle: "#ffb020",
  checkpoint: "#4488ff",
  dead: "#555555",
  suspended: "#ff4444",
};

const ROLE_COLORS: Record<string, string> = {
  kernel: "#00ff88",
  "sub-kernel": "#00d4ff",
  worker: "#555555",
  shell: "#555555",
};

const LEVEL_WIDTH = 160;
const LEVEL_HEIGHT = 100;

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
        overflow: hidden;
      }

      canvas {
        width: 100%;
        height: 100%;
        display: block;
        cursor: grab;
      }
      canvas:active { cursor: grabbing; }

      .empty {
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
        background: rgba(5, 5, 5, 0.92);
        border: 1px solid var(--lens-border);
        padding: 10px 14px;
        font-family: var(--lens-font-mono);
        font-size: 10px;
        color: var(--lens-text-dim);
        display: flex;
        flex-direction: column;
        gap: 6px;
        min-width: 180px;
        z-index: 10;
      }

      .legend-section-title {
        font-size: 9px;
        text-transform: uppercase;
        letter-spacing: 0.8px;
        color: var(--lens-text-dim);
        margin-bottom: 2px;
      }

      .legend-items {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .legend-item {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .legend-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        flex-shrink: 0;
      }

      .legend-dot.running { background: var(--lens-green); box-shadow: 0 0 4px var(--lens-green); }
      .legend-dot.sleeping { background: var(--lens-amber); }
      .legend-dot.checkpoint { background: var(--lens-blue); }
      .legend-dot.dead { background: var(--lens-gray); }
      .legend-dot.suspended { background: var(--lens-red); }

      .legend-line {
        width: 20px;
        height: 0;
        flex-shrink: 0;
      }

      .legend-line.parent-child { border-top: 1px solid rgba(255,255,255,0.3); }
      .legend-line.dependency { border-top: 1.5px dashed var(--lens-amber); }

      .controls {
        position: absolute;
        top: 12px;
        right: 12px;
        z-index: 10;
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .controls label {
        font-family: var(--lens-font-mono);
        font-size: 10px;
        color: var(--lens-text-dim);
        display: flex;
        align-items: center;
        gap: 5px;
        cursor: pointer;
        user-select: none;
        padding: 4px 8px;
        border: 1px solid var(--lens-border);
        background: rgba(5,5,5,0.92);
        transition: all 150ms ease;
      }

      .controls label:hover {
        border-color: var(--lens-border-bright);
        color: var(--lens-text-secondary);
      }

      .controls input[type="checkbox"] {
        appearance: none;
        width: 12px;
        height: 12px;
        border: 1px solid var(--lens-border-bright);
        background: var(--lens-bg-surface);
        cursor: pointer;
        position: relative;
      }

      .controls input[type="checkbox"]:checked {
        background: var(--lens-accent-dim);
        border-color: var(--lens-accent);
      }
    `,
  ];

  @property({ attribute: false }) nodes: LensDagNode[] = [];
  @property({ attribute: false }) edges: LensDagEdge[] = [];
  @property({ type: Boolean, attribute: "show-dead" }) showDead = false;

  @state() private _selectedPid: string | null = null;

  // Canvas state
  private _canvas: HTMLCanvasElement | null = null;
  private _positions: Record<string, NodePos> = {};
  private _offset = { x: 0, y: 0 };
  private _scale = 1;
  private _centered = false;
  private _animFrame = 0;
  private _dragging = false;
  private _dragStart = { x: 0, y: 0 };
  private _draggingNode: string | null = null;
  private _resizeObserver: ResizeObserver | null = null;

  private _onToggleDead(e: Event) {
    this.showDead = (e.target as HTMLInputElement).checked;
    this._positions = {};
    this._centered = false;
    this.dispatchEvent(new CustomEvent("show-dead-change", { detail: this.showDead, bubbles: true, composed: true }));
  }

  private get _visibleNodes(): LensDagNode[] {
    return this.showDead ? this.nodes : this.nodes.filter(n => n.state !== "dead");
  }

  private get _visibleEdges(): LensDagEdge[] {
    const pids = new Set(this._visibleNodes.map(n => n.pid));
    return this.edges.filter(e => pids.has(e.from) && pids.has(e.to));
  }

  // ── Tree layout ────────────────────────────────────────────────

  private _buildTree(procs: LensDagNode[]): Array<LensDagNode & { childNodes: LensDagNode[] }> {
    const map = new Map(procs.map(p => [p.pid, { ...p, childNodes: [] as LensDagNode[] }]));
    const roots: Array<LensDagNode & { childNodes: LensDagNode[] }> = [];

    // Build parent-child relationships from node parentPid (primary)
    // and from edges with relation === "parent-child" (fallback)
    const childOf = new Set<string>();

    for (const p of procs) {
      if (p.parentPid && map.has(p.parentPid)) {
        const parent = map.get(p.parentPid)!;
        parent.childNodes.push(map.get(p.pid)!);
        childOf.add(p.pid);
      }
    }

    // Also use edges with explicit parent-child relation
    for (const edge of this.edges) {
      if (edge.relation !== "parent-child") continue;
      const parent = map.get(edge.from);
      const child = map.get(edge.to);
      if (parent && child && !childOf.has(edge.to)) {
        parent.childNodes.push(child);
        childOf.add(edge.to);
      }
    }

    for (const p of procs) {
      if (!childOf.has(p.pid)) {
        roots.push(map.get(p.pid)!);
      }
    }

    return roots.length > 0 ? roots : [...map.values()];
  }

  private _layoutPositions(): Record<string, NodePos> {
    const procs = this._visibleNodes;
    if (procs.length === 0) return {};

    const tree = this._buildTree(procs);
    const positions: Record<string, NodePos> = {};
    let newNodesPlaced = false;

    const assignPositions = (nodes: Array<LensDagNode & { childNodes: LensDagNode[] }>, level: number, startX: number): number => {
      const widths = nodes.map(n =>
        n.childNodes.length > 0 ? Math.max(1, n.childNodes.length) * LEVEL_WIDTH : LEVEL_WIDTH
      );

      let currentX = startX;
      nodes.forEach((node, i) => {
        const w = widths[i];
        const cx = currentX + w / 2;
        const cy = level * LEVEL_HEIGHT;
        if (!this._positions[node.pid]) {
          positions[node.pid] = { x: cx, y: cy };
          newNodesPlaced = true;
        } else {
          positions[node.pid] = this._positions[node.pid];
        }
        if (node.childNodes.length > 0) {
          assignPositions(node.childNodes as Array<LensDagNode & { childNodes: LensDagNode[] }>, level + 1, currentX);
        }
        currentX += w;
      });
      return widths.reduce((a, b) => a + b, 0);
    };

    assignPositions(tree, 0, -(tree.length * LEVEL_WIDTH) / 2);
    this._positions = { ...this._positions, ...positions };

    // Auto-center: run whenever we haven't centered yet, or when canvas first gets real size
    if (!this._centered && this._canvas) {
      const rect = this._canvas.parentElement!.getBoundingClientRect();
      // Only center if the canvas is actually visible (has size)
      if (rect.width > 0 && rect.height > 0) {
        const allPos = Object.values(this._positions);
        if (allPos.length > 0) {
          const minX = Math.min(...allPos.map(p => p.x));
          const maxX = Math.max(...allPos.map(p => p.x));
          const minY = Math.min(...allPos.map(p => p.y));
          const maxY = Math.max(...allPos.map(p => p.y));
          const cx = (minX + maxX) / 2;
          const cy = (minY + maxY) / 2;
          this._offset.x = rect.width / 2 - cx * this._scale;
          this._offset.y = rect.height / 2 - cy * this._scale;
          this._centered = true;
        }
      }
    }

    return positions;
  }

  // ── Canvas rendering ───────────────────────────────────────────

  private _render() {
    const canvas = this._canvas;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const rect = canvas.parentElement!.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = rect.width + "px";
    canvas.style.height = rect.height + "px";
    ctx.scale(dpr, dpr);

    const positions = this._layoutPositions();
    const ox = this._offset.x;
    const oy = this._offset.y;
    const scale = this._scale;

    ctx.clearRect(0, 0, rect.width, rect.height);

    // Subtle grid
    ctx.save();
    const gridSize = 40 * scale;
    const gridOffX = ox % gridSize;
    const gridOffY = oy % gridSize;
    ctx.strokeStyle = "rgba(255,255,255,0.02)";
    ctx.lineWidth = 0.5;
    for (let x = gridOffX; x < rect.width; x += gridSize) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, rect.height); ctx.stroke();
    }
    for (let y = gridOffY; y < rect.height; y += gridSize) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(rect.width, y); ctx.stroke();
    }
    ctx.restore();

    ctx.save();
    ctx.translate(ox, oy);
    ctx.scale(scale, scale);

    const edges = this._visibleEdges;
    const procs = this._visibleNodes;

    // ── Draw edges ──
    edges.forEach(edge => {
      const from = positions[edge.from];
      const to = positions[edge.to];
      if (!from || !to) return;

      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      const midY = (from.y + to.y) / 2;
      ctx.bezierCurveTo(from.x, midY, to.x, midY, to.x, to.y);

      const isDep = edge.relation === "dependency";
      if (isDep) {
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = "rgba(255,176,32,0.3)";
        ctx.lineWidth = 1.5;
      } else {
        ctx.setLineDash([]);
        ctx.strokeStyle = "rgba(255,255,255,0.12)";
        ctx.lineWidth = 1;
      }
      ctx.stroke();
      ctx.setLineDash([]);

      // Animated pulse dot along edge (travels from → to)
      const t = (Date.now() % 3000) / 3000;
      const bx = (1-t)*(1-t)*(1-t)*from.x + 3*(1-t)*(1-t)*t*from.x + 3*(1-t)*t*t*to.x + t*t*t*to.x;
      const by = (1-t)*(1-t)*(1-t)*from.y + 3*(1-t)*(1-t)*t*midY + 3*(1-t)*t*t*midY + t*t*t*to.y;
      ctx.beginPath();
      ctx.arc(bx, by, 2, 0, Math.PI * 2);
      ctx.fillStyle = isDep ? "rgba(255,176,32,0.5)" : "rgba(0,255,136,0.3)";
      ctx.fill();

      // Edge label for dependency edges
      if (isDep && edge.label) {
        const lx = (from.x + to.x) / 2;
        const ly = (from.y + to.y) / 2 - 6;
        ctx.font = "9px 'IBM Plex Mono', monospace";
        ctx.fillStyle = "rgba(255,176,32,0.5)";
        ctx.textAlign = "center";
        ctx.fillText(edge.label, lx, ly);
      }
    });

    // ── Draw nodes ──
    procs.forEach(proc => {
      const pos = positions[proc.pid];
      if (!pos) return;

      const role = proc.role;
      const r = role === "kernel" ? 28 : role === "sub-kernel" ? 24 : 22;
      const color = STATE_COLORS[proc.state] ?? "#555";
      const ringColor = ROLE_COLORS[role] ?? "#555";
      const isSelected = proc.pid === this._selectedPid;

      // Glow for kernel
      if (role === "kernel") {
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, r + 6, 0, Math.PI * 2);
        const grad = ctx.createRadialGradient(pos.x, pos.y, r, pos.x, pos.y, r + 8);
        grad.addColorStop(0, "rgba(0,255,136,0.08)");
        grad.addColorStop(1, "rgba(0,255,136,0)");
        ctx.fillStyle = grad;
        ctx.fill();
      }

      // Sub-kernel double ring
      if (role === "sub-kernel") {
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, r + 3, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(0,212,255,0.15)";
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // Node circle
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
      ctx.fillStyle = isSelected ? "rgba(0,255,136,0.12)" : "#0a0a0a";
      ctx.fill();
      ctx.lineWidth = isSelected ? 2 : 1;
      ctx.strokeStyle = isSelected ? color : ringColor;
      ctx.globalAlpha = isSelected ? 1 : (role === "shell" || role === "worker" ? 0.4 : 0.6);
      ctx.stroke();
      ctx.globalAlpha = 1;

      // Inner state dot
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = color;
      // Pulse for running state
      if (proc.state === "running") {
        const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 500);
        ctx.globalAlpha = 0.4 + 0.6 * pulse;
      }
      ctx.fill();
      ctx.globalAlpha = 1;

      // Label
      ctx.font = "11px 'IBM Plex Mono', monospace";
      ctx.fillStyle = "#ccc";
      ctx.textAlign = "center";
      ctx.fillText(proc.name, pos.x, pos.y + r + 16);

      // Role label
      ctx.font = "9px 'IBM Plex Mono', monospace";
      ctx.fillStyle = ringColor;
      ctx.fillText(role, pos.x, pos.y + r + 28);

      // State label
      ctx.fillStyle = color;
      ctx.fillText(proc.state, pos.x, pos.y + r + 38);
    });

    ctx.restore();
  }

  private _animLoop = () => {
    this._render();
    this._animFrame = requestAnimationFrame(this._animLoop);
  };

  // ── Interaction ────────────────────────────────────────────────

  private _hitTest(clientX: number, clientY: number): string | null {
    if (!this._canvas) return null;
    const rect = this._canvas.getBoundingClientRect();
    const mx = (clientX - rect.left - this._offset.x) / this._scale;
    const my = (clientY - rect.top - this._offset.y) / this._scale;

    for (const proc of this._visibleNodes) {
      const pos = this._positions[proc.pid];
      if (!pos) continue;
      const r = proc.role === "kernel" ? 28 : proc.role === "sub-kernel" ? 24 : 22;
      const dx = mx - pos.x;
      const dy = my - pos.y;
      if (dx * dx + dy * dy <= (r + 4) * (r + 4)) {
        return proc.pid;
      }
    }
    return null;
  }

  private _onMouseDown = (e: MouseEvent) => {
    const hit = this._hitTest(e.clientX, e.clientY);
    if (hit) {
      this._draggingNode = hit;
      this._selectedPid = hit;
      this.dispatchEvent(new CustomEvent("process-select", { detail: { pid: hit }, bubbles: true, composed: true }));
    } else {
      this._dragging = true;
      this._dragStart.x = e.clientX - this._offset.x;
      this._dragStart.y = e.clientY - this._offset.y;
    }
  };

  private _onMouseMove = (e: MouseEvent) => {
    if (this._draggingNode && this._canvas) {
      const rect = this._canvas.getBoundingClientRect();
      this._positions[this._draggingNode] = {
        x: (e.clientX - rect.left - this._offset.x) / this._scale,
        y: (e.clientY - rect.top - this._offset.y) / this._scale,
      };
    } else if (this._dragging) {
      this._offset.x = e.clientX - this._dragStart.x;
      this._offset.y = e.clientY - this._dragStart.y;
    }
  };

  private _onMouseUp = () => {
    this._dragging = false;
    this._draggingNode = null;
  };

  private _onWheel = (e: WheelEvent) => {
    e.preventDefault();
    if (!this._canvas) return;
    const rect = this._canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    const newScale = Math.max(0.3, Math.min(3, this._scale * factor));

    this._offset.x = mouseX - (mouseX - this._offset.x) * (newScale / this._scale);
    this._offset.y = mouseY - (mouseY - this._offset.y) * (newScale / this._scale);
    this._scale = newScale;
  };

  // ── Lifecycle ──────────────────────────────────────────────────

  override firstUpdated() {
    this._attachCanvas();
    this._animFrame = requestAnimationFrame(this._animLoop);
  }

  private _attachCanvas() {
    const canvas = this.renderRoot.querySelector("canvas");
    if (canvas && canvas !== this._canvas) {
      // Detach old listeners
      if (this._canvas) {
        this._canvas.removeEventListener("mousedown", this._onMouseDown);
        this._canvas.removeEventListener("mousemove", this._onMouseMove);
        this._canvas.removeEventListener("mouseup", this._onMouseUp);
        this._canvas.removeEventListener("mouseleave", this._onMouseUp);
        this._canvas.removeEventListener("wheel", this._onWheel);
        this._resizeObserver?.disconnect();
      }

      this._canvas = canvas;
      canvas.addEventListener("mousedown", this._onMouseDown);
      canvas.addEventListener("mousemove", this._onMouseMove);
      canvas.addEventListener("mouseup", this._onMouseUp);
      canvas.addEventListener("mouseleave", this._onMouseUp);
      canvas.addEventListener("wheel", this._onWheel, { passive: false });

      this._resizeObserver = new ResizeObserver(() => this._render());
      this._resizeObserver.observe(canvas.parentElement!);

      // Force re-center on new canvas
      this._centered = false;
    }
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    cancelAnimationFrame(this._animFrame);
    this._resizeObserver?.disconnect();
  }

  override updated(changed: Map<string, unknown>) {
    // Re-attach canvas when DOM changes (e.g. switching from "No processes" to canvas)
    this._attachCanvas();

    if (changed.has("nodes")) {
      const currentPids = new Set(this.nodes.map(n => n.pid));
      const positionPids = Object.keys(this._positions);
      const hasStale = positionPids.some(pid => !currentPids.has(pid));
      const hasNew = this.nodes.some(n => !this._positions[n.pid]);

      if (hasStale || hasNew) {
        const cleaned: Record<string, NodePos> = {};
        for (const pid of currentPids) {
          if (this._positions[pid]) cleaned[pid] = this._positions[pid];
        }
        this._positions = cleaned;
        if (hasStale) this._centered = false;
      }
    }
  }

  protected override render() {
    if (this.nodes.length === 0) {
      return html`<div class="container"><div class="empty">No processes</div></div>`;
    }

    return html`
      <div class="container">
        <canvas></canvas>

        <div class="controls">
          <label>
            <input type="checkbox" .checked=${this.showDead} @change=${this._onToggleDead} />
            Show dead processes
          </label>
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
