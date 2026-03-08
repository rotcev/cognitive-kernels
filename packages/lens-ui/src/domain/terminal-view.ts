import { html, css, nothing } from "lit";
import { customElement, property, state, query } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { LensElement, lensBaseStyles } from "../tokens/base.js";
import type { LensTerminalLine } from "../mock/types.js";

// ── Data helpers ─────────────────────────────────────────────────

function parseTool(text: string): { action: string; name: string; detail: string } | null {
  const m = text.match(/^(tool_\w+):\s*(\S+)(?:\s*—\s*(.+))?$/s);
  if (!m) return null;
  return { action: m[1], name: m[2], detail: m[3]?.trim() ?? "" };
}

const CONTROL_TOOLS = new Set(["StructuredOutput", "structuredoutput"]);
const CONTROL_ACTIONS = new Set(["exit", "sleeping", "continue", "idle"]);
function isControlSignal(tool: { name: string; detail: string }): boolean {
  return CONTROL_TOOLS.has(tool.name) && CONTROL_ACTIONS.has(tool.detail.toLowerCase());
}

function formatTime(iso: string): string {
  return new Date(iso).toTimeString().slice(0, 8);
}

function shouldHide(line: LensTerminalLine): boolean {
  const t = line.text.trim();
  if (!t) return true;
  if (/^\*{1,3}$/.test(t)) return true;
  if (/^[-|:\s]+$/.test(t)) return true;
  return false;
}

function isNoise(line: LensTerminalLine): boolean {
  return line.level === "info" && line.text.startsWith("usage:");
}

// ── Agent colors ─────────────────────────────────────────────────

const FIXED_COLORS: Record<string, string> = {
  "goal-orchestrator": "#00ff88",
  "metacog-daemon": "#c864ff",
  "awareness-daemon": "#ff6b9d",
  "memory-consolidator": "#4488ff",
};
const PALETTE = ["#00d4ff","#ffb020","#ff6b6b","#a78bfa","#34d399","#f472b6","#fbbf24","#60a5fa","#fb923c","#2dd4bf"];
function hashStr(s: string): number { let h=0; for(let i=0;i<s.length;i++) h=((h<<5)-h+s.charCodeAt(i))|0; return Math.abs(h); }
const _cc = new Map<string, string>();
function agentColor(name: string): string {
  if (FIXED_COLORS[name]) return FIXED_COLORS[name];
  let c = _cc.get(name);
  if (!c) { c = PALETTE[hashStr(name) % PALETTE.length]; _cc.set(name, c); }
  return c;
}

const TOOL_COLORS: Record<string, string> = {
  read: "#60a5fa", write: "#34d399", edit: "#fbbf24", bash: "#f87171",
  glob: "#a78bfa", grep: "#a78bfa", task: "#00d4ff", taskoutput: "#00d4ff",
};
function toolColor(name: string): string {
  return TOOL_COLORS[name.toLowerCase()] ?? "var(--lens-text-dim)";
}

// ── Markdown ─────────────────────────────────────────────────────

function renderMd(text: string): string {
  let s = text.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  s = s.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre class="cb">$2</pre>');
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/^#{1,3}\s+(.+)$/gm, '<div class="hd">$1</div>');
  s = s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  s = s.replace(/\*\*/g, '');
  s = s.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<i>$1</i>');
  s = s.replace(/(?:^|\n)((?:\|.+\|\n?){3,})/g, (_, block: string) => {
    const rows = block.trim().split("\n").filter(r => r.trim());
    const data = rows.filter(r => !r.match(/^\|[\s\-:|]+\|$/));
    if (!data.length) return block;
    const cell = (row: string, h: boolean) => {
      const cells = row.split("|").slice(1,-1).map(c=>c.trim());
      const t = h ? "th" : "td";
      return `<tr>${cells.map(c=>`<${t}>${c}</${t}>`).join("")}</tr>`;
    };
    return `<table class="tb">${cell(data[0],true)}${data.slice(1).map(r=>cell(r,false)).join("")}</table>`;
  });
  s = s.replace(/^[\s]*[-*]\s+(.+)$/gm, '<div class="li">$1</div>');
  s = s.replace(/^\s*\d+\.\s+(.+)$/gm, '<div class="li">$1</div>');
  s = s.replace(/^---+$/gm, '<hr class="sep">');
  return s;
}

// ── Tool I/O cards ──────────────────────────────────────────────

interface ToolCard {
  kind: "tool-card";
  seq: number;
  pid: string;
  processName: string;
  timestamp: string;
  level: "tool";
  toolName: string;
  command: string;
  output: string;
  status: "running" | "done" | "failed";
}

/**
 * Collapse consecutive tool_started → thinking (output) → tool_completed
 * from the same PID into a single ToolCard pseudo-line.
 */
function collapseToolCards(lines: LensTerminalLine[]): Array<LensTerminalLine | ToolCard> {
  const out: Array<LensTerminalLine | ToolCard> = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.level === "tool") {
      const t = parseTool(line.text);
      if (t && t.action === "tool_started" && /^bash$/i.test(t.name)) {
        let output = "";
        let j = i + 1;
        let status: "running" | "done" | "failed" = "running";
        while (j < lines.length && lines[j].pid === line.pid) {
          const next = lines[j];
          if (next.level === "thinking") {
            output += next.text;
            j++;
          } else if (next.level === "tool") {
            const nt = parseTool(next.text);
            if (nt && (nt.action === "tool_completed" || nt.action === "tool_failed") && /^bash$/i.test(nt.name)) {
              status = nt.action === "tool_failed" ? "failed" : "done";
              j++;
            }
            break;
          } else {
            break;
          }
        }
        out.push({
          kind: "tool-card",
          seq: line.seq,
          pid: line.pid,
          processName: line.processName,
          timestamp: line.timestamp,
          level: "tool",
          toolName: t.name,
          command: t.detail,
          output: output.trim(),
          status,
        });
        i = j;
        continue;
      }
    }
    out.push(line);
    i++;
  }
  return out;
}

function isToolCard(item: LensTerminalLine | ToolCard): item is ToolCard {
  return "kind" in item && item.kind === "tool-card";
}

// ── Grouping ─────────────────────────────────────────────────────

type TurnItem = LensTerminalLine | ToolCard;

interface Turn {
  pid: string;
  processName: string;
  startTime: string;
  lines: TurnItem[];
}

function groupIntoTurns(lines: TurnItem[]): Turn[] {
  const turns: Turn[] = [];
  for (const line of lines) {
    if (!isToolCard(line) && shouldHide(line)) continue;
    const last = turns[turns.length - 1];
    if (last && last.pid === line.pid) {
      last.lines.push(line);
    } else {
      turns.push({ pid: line.pid, processName: line.processName, startTime: line.timestamp, lines: [line] });
    }
  }
  return turns;
}

// ── Component ────────────────────────────────────────────────────

@customElement("lens-terminal-view")
export class LensTerminalView extends LensElement {
  static override styles = [
    lensBaseStyles,
    css`
      :host {
        display: flex; flex-direction: column; height: 100%;
        font-family: var(--lens-font-mono);
        background: var(--lens-bg-root);
      }

      /* ── Header ────────────────────────────────── */
      .header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 6px 12px;
        border-bottom: 1px solid var(--lens-border);
        font-size: 10px; background: var(--lens-bg-panel);
      }
      .header-left { display: flex; gap: 6px; color: var(--lens-text-dim); align-items: center; }
      .header-left .proc-name { color: var(--lens-text); }
      .header-right { display: flex; gap: 10px; align-items: center; }
      .autoscroll-label { display: flex; gap: 4px; font-size: 10px; color: var(--lens-text-dim); cursor: pointer; align-items: center; }
      .autoscroll-cb {
        appearance: none; width: 12px; height: 12px;
        border: 1px solid var(--lens-border-bright); border-radius: 2px;
        background: transparent; cursor: pointer; position: relative;
      }
      .autoscroll-cb:checked { border-color: var(--lens-accent); background: var(--lens-accent-dim); }
      .autoscroll-cb:checked::after {
        content: ""; position: absolute; top: 1px; left: 3px;
        width: 4px; height: 7px; border: solid var(--lens-accent);
        border-width: 0 1.5px 1.5px 0; transform: rotate(45deg);
      }
      .clear-btn {
        font-family: var(--lens-font-mono); font-size: 10px;
        padding: 2px 8px; border: 1px solid var(--lens-border);
        border-radius: 2px; background: transparent;
        color: var(--lens-text-dim); cursor: pointer;
      }
      .clear-btn:hover { color: var(--lens-text); border-color: var(--lens-border-bright); }

      /* ── Scroll ────────────────────────────────── */
      .scroll { flex: 1; overflow-y: auto; padding: 4px 0; }

      /* ── Column legend (subtle) ────────────────── */
      .col-legend {
        display: grid; grid-template-columns: 56px 140px minmax(0, 1fr);
        padding: 4px 12px 6px; gap: 0;
        font-size: 9px; color: var(--lens-text-dim);
        opacity: 0.5; text-transform: uppercase; letter-spacing: 0.5px;
        border-bottom: 1px solid rgba(255,255,255,0.04);
      }

      /* ── Log row ───────────────────────────────── */
      .row {
        display: grid;
        grid-template-columns: 56px 140px minmax(0, 1fr);
        padding: 1px 12px;
        min-height: 20px;
        align-items: start;
        transition: background 0.08s;
      }
      .row:hover { background: rgba(255,255,255,0.02); }
      .row.group-start { margin-top: 8px; }

      /* Time column */
      .col-time {
        font-size: 10px; color: var(--lens-text-dim);
        padding-top: 2px; user-select: none;
      }

      /* Agent column */
      .col-agent {
        display: flex; align-items: center; gap: 5px;
        font-size: 10px; padding-top: 2px;
        overflow: hidden; user-select: none;
      }
      .col-agent.clickable { cursor: pointer; }
      .col-agent.clickable:hover .name { text-decoration: underline; text-underline-offset: 2px; }
      .dot {
        width: 6px; height: 6px; border-radius: 50%;
        flex-shrink: 0;
      }
      .name {
        font-weight: 600;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .more-badge {
        font-size: 9px; font-weight: 400;
        color: var(--lens-text-dim); background: rgba(255,255,255,0.05);
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 3px; padding: 0 5px;
        flex-shrink: 0; line-height: 1.5;
      }

      /* Content column */
      .col-content {
        min-width: 0; padding: 1px 0;
        font-size: 11px; line-height: 1.5;
        color: var(--lens-text-secondary);
      }

      /* ── Tool call ─────────────────────────────── */
      .tool-row {
        display: inline-flex; align-items: center; gap: 0;
        border-radius: 3px; overflow: hidden;
        background: rgba(0,0,0,0.2);
        border: 1px solid rgba(255,255,255,0.05);
        max-width: 100%;
      }
      .tool-icon {
        width: 18px; display: flex; align-items: center;
        justify-content: center; font-size: 8px; flex-shrink: 0;
        align-self: stretch;
      }
      .tool-badge {
        padding: 2px 7px; font-size: 10px; font-weight: 600;
        letter-spacing: 0.02em;
        border-right: 1px solid rgba(255,255,255,0.06);
        flex-shrink: 0;
      }
      .tool-detail {
        padding: 2px 7px; font-size: 10px;
        color: var(--lens-text-secondary);
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        min-width: 0;
      }
      .tool-detail.bash { color: var(--lens-text); }
      .tool-detail.bash::before { content: "$ "; color: var(--lens-text-dim); font-size: 9px; }

      /* ── Control signal ────────────────────────── */
      .ctrl {
        font-size: 10px; font-style: italic;
      }
      .ctrl.exit { color: var(--lens-red); }
      .ctrl.sleeping { color: var(--lens-amber); }
      .ctrl.continue, .ctrl.idle { color: var(--lens-text-dim); }

      /* ── Thinking (collapsed) ──────────────────── */
      .think-row {
        display: flex; align-items: center; gap: 6px;
        cursor: pointer; padding: 2px 0;
        color: var(--lens-text-secondary);
        transition: color 0.1s;
      }
      .think-row:hover { color: var(--lens-text); }
      .think-icon { font-size: 11px; flex-shrink: 0; }
      .think-preview {
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        flex: 1; min-width: 0;
      }
      .show-btn, .hide-btn {
        font-size: 9px; font-family: var(--lens-font-mono);
        border-radius: 3px; padding: 1px 7px;
        flex-shrink: 0; letter-spacing: 0.3px;
        transition: all 0.1s;
      }
      .show-btn {
        color: var(--lens-accent); background: rgba(0,212,255,0.06);
        border: 1px solid rgba(0,212,255,0.15);
      }
      .think-row:hover .show-btn {
        background: rgba(0,212,255,0.12); border-color: rgba(0,212,255,0.3);
      }
      .hide-btn {
        color: var(--lens-text-dim); background: rgba(255,255,255,0.04);
        border: 1px solid rgba(255,255,255,0.08);
        cursor: pointer;
      }
      .hide-btn:hover { color: var(--lens-text-secondary); border-color: rgba(255,255,255,0.15); }

      /* ── Thinking (expanded) ───────────────────── */
      .think-box {
        margin: 3px 0; border-radius: 4px; overflow: hidden;
        background: rgba(255,255,255,0.015);
        border: 1px solid rgba(255,255,255,0.06);
      }
      .think-box-header {
        display: flex; align-items: center; gap: 6px;
        padding: 4px 8px; cursor: pointer;
        border-bottom: 1px solid rgba(255,255,255,0.04);
      }
      .think-box-header:hover { background: rgba(255,255,255,0.02); }
      .think-box-header .lbl { font-size: 10px; color: var(--lens-text-dim); flex: 1; }
      .think-body {
        font-size: 11px; line-height: 1.55;
        color: rgba(200,200,200,0.75);
        word-break: break-word; padding: 8px 10px;
      }
      .think-body b { color: var(--lens-text); font-weight: 500; }
      .think-body i { font-style: italic; }
      .think-body code {
        background: rgba(255,255,255,0.06); padding: 1px 4px;
        border-radius: 2px; font-size: 10px; color: var(--lens-amber);
      }
      .think-body .cb {
        background: rgba(0,0,0,0.3); border: 1px solid var(--lens-border);
        border-radius: 3px; padding: 5px 7px; margin: 3px 0;
        font-size: 10px; color: var(--lens-text-secondary); overflow-x: auto;
        white-space: pre;
      }
      .think-body .hd { color: var(--lens-text); font-weight: 500; margin-top: 4px; }
      .think-body .tb { border-collapse: collapse; margin: 4px 0; font-size: 10px; width: 100%; }
      .think-body .tb th, .think-body .tb td {
        border: 1px solid var(--lens-border); padding: 3px 6px; text-align: left;
      }
      .think-body .tb th { background: rgba(255,255,255,0.03); color: var(--lens-text-dim); font-weight: 500; }
      .think-body .li { padding-left: 12px; position: relative; }
      .think-body .li::before { content: "\\2022"; position: absolute; left: 2px; color: var(--lens-text-dim); }
      .think-body .sep { border: none; border-top: 1px solid var(--lens-border); margin: 4px 0; }

      /* ── System event ──────────────────────────── */
      .sys-row {
        display: inline-flex; align-items: center; gap: 4px;
        font-size: 9px; color: var(--lens-text-dim); opacity: 0.7;
      }
      .sys-tag {
        text-transform: uppercase; letter-spacing: 0.4px;
        padding: 0 4px; border-radius: 2px; font-size: 8px;
      }
      .sys-tag.boot { color: var(--lens-cyan); background: rgba(0,212,255,0.08); }
      .sys-tag.spawn { color: var(--lens-green); background: rgba(0,255,136,0.08); }
      .sys-tag.exit { color: var(--lens-text-dim); background: rgba(255,255,255,0.04); }
      .sys-tag.sys { color: var(--lens-amber); background: rgba(255,176,32,0.06); }
      .sys-text {
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }

      /* ── Noise ─────────────────────────────────── */
      .noise { font-size: 9px; color: var(--lens-text-dim); opacity: 0.3; }

      /* ── Output ────────────────────────────────── */
      .output-text {
        color: var(--lens-green);
        white-space: pre-wrap; word-break: break-word;
      }

      /* ── Error ─────────────────────────────────── */
      .error-text {
        color: var(--lens-red);
        white-space: pre-wrap; word-break: break-word;
      }

      /* ── Info fallback ─────────────────────────── */
      .info-text { color: var(--lens-text-dim); font-size: 10px; }

      /* ── Tool I/O card ─────────────────────────── */
      .io-card {
        border-radius: 4px; overflow: hidden;
        background: rgba(0,0,0,0.25);
        border: 1px solid rgba(255,255,255,0.06);
        margin: 2px 0;
      }
      .io-card.done { border-color: rgba(0,255,136,0.12); }
      .io-card.failed { border-color: rgba(255,68,68,0.2); }
      .io-card-header {
        display: flex; align-items: center; gap: 0;
        cursor: pointer; transition: background 0.1s;
      }
      .io-card-header:hover { background: rgba(255,255,255,0.02); }
      .io-card-icon {
        width: 22px; display: flex; align-items: center;
        justify-content: center; font-size: 9px; flex-shrink: 0;
        align-self: stretch;
      }
      .io-card.done .io-card-icon { background: rgba(0,255,136,0.08); color: var(--lens-green); }
      .io-card.failed .io-card-icon { background: rgba(255,68,68,0.1); color: var(--lens-red); }
      .io-card.running .io-card-icon { background: rgba(255,255,255,0.03); color: var(--lens-amber); }
      .io-card-tool {
        padding: 3px 7px; font-size: 10px; font-weight: 600;
        letter-spacing: 0.02em;
        border-right: 1px solid rgba(255,255,255,0.06);
        flex-shrink: 0;
      }
      .io-card-cmd {
        padding: 3px 8px; font-size: 10px;
        color: var(--lens-text);
        flex: 1; min-width: 0;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .io-card-cmd::before { content: "$ "; color: var(--lens-text-dim); font-size: 9px; }
      .io-card-toggle {
        font-size: 9px; font-family: var(--lens-font-mono);
        padding: 2px 8px; margin-right: 4px;
        color: var(--lens-text-dim); flex-shrink: 0;
        border: none; background: transparent; cursor: pointer;
      }
      .io-card-output {
        border-top: 1px solid rgba(255,255,255,0.04);
        padding: 6px 8px;
        font-size: 10px; line-height: 1.5;
        color: var(--lens-text-secondary);
        white-space: pre-wrap; word-break: break-word;
        max-height: 300px; overflow-y: auto;
        background: rgba(0,0,0,0.15);
      }

      /* ── Empty / cursor ────────────────────────── */
      .cursor-row {
        padding: 2px 12px 2px calc(56px + 140px + 12px);
      }
      .cursor-blink {
        display: inline-block; width: 7px; height: 13px;
        background: var(--lens-accent); animation: blink 1s step-end infinite;
      }
      @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }
      .empty-state {
        display: flex; align-items: center; justify-content: center;
        height: 100%; color: var(--lens-text-dim); font-size: 12px;
      }

      /* ── Compact mode (drawer) ───────────────── */
      :host([compact]) .header { display: none; }
      :host([compact]) .col-legend { display: none; }
      :host([compact]) .row {
        grid-template-columns: 1fr;
        padding: 1px 8px;
      }
      :host([compact]) .col-time { display: none; }
      :host([compact]) .col-agent { display: none; }
      :host([compact]) .row.group-start { margin-top: 6px; padding-top: 6px; border-top: 1px solid rgba(255,255,255,0.04); }
      :host([compact]) .row.group-start:first-child { margin-top: 0; border-top: none; }
      :host([compact]) .cursor-row { padding: 2px 8px; }
      :host([compact]) .tool-detail { max-width: 100%; }
      :host([compact]) .think-preview { font-size: 10px; }
      :host([compact]) .scroll { padding: 4px 0; }
    `,
  ];

  @property({ type: Array }) lines: LensTerminalLine[] = [];
  @property({ type: Boolean }) autoscroll = true;
  @property({ type: String }) processFilter = "";
  @property({ type: Boolean, reflect: true }) compact = false;
  @query(".scroll") private _scrollEl!: HTMLElement;
  @state() private _expandedThinking = new Set<number>();
  @state() private _expandedCards = new Set<number>();
  @state() private _collapsedTurns = new Set<number>();

  /** Non-reactive flag — suppresses autoscroll during toggle without triggering re-render. */
  private _suppressAutoscroll = false;

  protected override updated() {
    if (this.autoscroll && !this._suppressAutoscroll && this._scrollEl) {
      this._scrollEl.scrollTop = this._scrollEl.scrollHeight;
    }
  }

  /** Merge consecutive thinking lines from same PID, then collapse tool I/O cards. */
  private get _merged(): TurnItem[] {
    const source = this.processFilter
      ? this.lines.filter(l => l.pid === this.processFilter)
      : this.lines;
    if (!source.length) return source;
    const out: LensTerminalLine[] = [];
    let cur = { ...source[0] };
    for (let i = 1; i < source.length; i++) {
      const l = source[i];
      if (l.pid === cur.pid && l.level === cur.level && l.level === "thinking") {
        cur = { ...cur, text: cur.text + l.text };
      } else { out.push(cur); cur = { ...l }; }
    }
    out.push(cur);
    return collapseToolCards(out);
  }

  /**
   * Preserve the clicked element's screen position across a re-render.
   * Records offsetTop before toggle, then after Lit updates the DOM,
   * adjusts scrollTop so the element stays in the same visual spot.
   */
  private _stableToggle(target: EventTarget | null, mutate: () => void) {
    const el = (target as HTMLElement)?.closest?.(".row") as HTMLElement | null;
    const scrollEl = this._scrollEl;
    if (!el || !scrollEl) { mutate(); return; }

    const viewportY = el.getBoundingClientRect().top;

    this._suppressAutoscroll = true;
    mutate();

    this.updateComplete.then(() => {
      if (el.isConnected) {
        const newTop = el.getBoundingClientRect().top;
        scrollEl.scrollTop += newTop - viewportY;
      }
      this._suppressAutoscroll = false;
    });
  }

  private _toggleCard(seq: number, e?: Event) {
    this._stableToggle(e?.currentTarget ?? null, () => {
      const n = new Set(this._expandedCards);
      if (n.has(seq)) n.delete(seq); else n.add(seq);
      this._expandedCards = n;
    });
  }

  private _toggleThinking(seq: number, e?: Event) {
    this._stableToggle(e?.currentTarget ?? null, () => {
      const n = new Set(this._expandedThinking);
      if (n.has(seq)) n.delete(seq); else n.add(seq);
      this._expandedThinking = n;
    });
  }

  private _toggleTurn(key: number, e?: Event) {
    this._stableToggle(e?.currentTarget ?? null, () => {
      const n = new Set(this._collapsedTurns);
      if (n.has(key)) n.delete(key); else n.add(key);
      this._collapsedTurns = n;
    });
  }

  private _onAutoscrollChange(e: Event) {
    this.autoscroll = (e.target as HTMLInputElement).checked;
  }

  private _onClear() {
    this.dispatchEvent(new CustomEvent("clear", { bubbles: true, composed: true }));
  }

  private _processLabel(): string {
    if (!this.processFilter) return "all";
    return this.lines.find(l => l.pid === this.processFilter)?.processName ?? this.processFilter;
  }

  // ── Render content (for the content column) ──────────────────

  private _renderItem(item: TurnItem) {
    if (isToolCard(item)) return this._renderToolCard(item);
    return this._renderContent(item);
  }

  private _renderToolCard(card: ToolCard) {
    const expanded = this._expandedCards.has(card.seq);
    const icon = card.status === "failed" ? "\u2717" : card.status === "done" ? "\u2713" : "\u25B6";
    const tc = toolColor(card.toolName);
    const hasOutput = card.output.length > 0;
    const outputPreview = card.output.length > 120
      ? card.output.slice(0, 120) + "…"
      : card.output;

    return html`
      <div class="io-card ${card.status}">
        <div class="io-card-header" @click=${(e: Event) => hasOutput ? this._toggleCard(card.seq, e) : null}>
          <span class="io-card-icon">${icon}</span>
          <span class="io-card-tool" style="color:${tc}">${card.toolName}</span>
          <span class="io-card-cmd">${card.command}</span>
          ${hasOutput ? html`<span class="io-card-toggle">${expanded ? "▾" : "▸"}</span>` : nothing}
        </div>
        ${expanded && hasOutput
          ? html`<div class="io-card-output">${card.output}</div>`
          : !expanded && hasOutput
            ? html`<div class="io-card-output" style="max-height:20px;overflow:hidden;opacity:0.5;padding:2px 8px;font-size:9px">${outputPreview}</div>`
            : nothing}
      </div>
    `;
  }

  private _renderContent(line: LensTerminalLine) {
    if (shouldHide(line)) return nothing;
    if (isNoise(line)) return html`<span class="noise">${line.text}</span>`;

    // ── Tool calls
    if (line.level === "tool") {
      const t = parseTool(line.text);
      if (t) {
        if (isControlSignal(t)) {
          const cls = t.detail.toLowerCase();
          return html`<span class="ctrl ${cls}">${t.detail}</span>`;
        }
        const isDone = t.action === "tool_completed";
        const isFail = t.action === "tool_failed";
        const icon = isFail ? "\u2717" : isDone ? "\u2713" : "\u25B6";
        const iconBg = isFail ? "rgba(255,68,68,0.1)" : isDone ? "rgba(0,255,136,0.08)" : "rgba(255,255,255,0.03)";
        const iconColor = isFail ? "var(--lens-red)" : isDone ? "var(--lens-green)" : toolColor(t.name);
        const badgeColor = toolColor(t.name);
        const isBash = /^bash$/i.test(t.name);
        return html`
          <span class="tool-row">
            <span class="tool-icon" style="background:${iconBg};color:${iconColor}">${icon}</span>
            <span class="tool-badge" style="color:${badgeColor}">${t.name}</span>
            ${t.detail ? html`<span class="tool-detail ${isBash ? "bash" : ""}">${t.detail}</span>` : nothing}
          </span>
        `;
      }
    }

    // ── Thinking
    if (line.level === "thinking") {
      let text = line.text.replace(/\*\*/g, "").trim();
      text = text.replace(/^[a-z]+:\s*/i, (m) => m.includes(":") && m.length < 12 ? "" : m);
      if (!text) return nothing;

      const isExpanded = this._expandedThinking.has(line.seq);
      if (!isExpanded) {
        const preview = text.replace(/[#*_`|]/g, "").replace(/\n/g, " ").slice(0, 120);
        return html`
          <div class="think-row" @click=${(e: Event) => this._toggleThinking(line.seq, e)}>
            <span class="think-icon">&#x1F4AD;</span>
            <span class="think-preview">${preview}</span>
            <span class="show-btn">Show</span>
          </div>
        `;
      }
      return html`
        <div class="think-box">
          <div class="think-box-header" @click=${(e: Event) => this._toggleThinking(line.seq, e)}>
            <span class="think-icon">&#x1F4AD;</span>
            <span class="lbl">Thinking</span>
            <span class="hide-btn">Hide</span>
          </div>
          <div class="think-body">${unsafeHTML(renderMd(text))}</div>
        </div>
      `;
    }

    // ── Output
    if (line.level === "output") return html`<span class="output-text">${line.text}</span>`;

    // ── Error
    if (line.level === "error") return html`<span class="error-text">${line.text}</span>`;

    // ── System
    if (line.level === "system") {
      const t = line.text;
      let tag: string, body: string;
      if (t.startsWith("exit:") || t.startsWith("exit ")) { tag="exit"; body=t.replace(/^exit:?\s*/, ""); }
      else if (t.startsWith("boot ") || t.includes("Process spawned")) { tag="boot"; body=t.replace(/^boot\s*/, "").replace(/Process spawned:\s*/, ""); }
      else if (t.includes("parent=") || t.includes("triggered") || t.includes("spawn") || t.includes("graph ")) { tag="spawn"; body=t; }
      else { tag="sys"; body=t; }
      return html`
        <span class="sys-row">
          <span class="sys-tag ${tag}">${tag}</span>
          <span class="sys-text">${body}</span>
        </span>
      `;
    }

    // ── Fallback
    return html`<span class="info-text">${line.text}</span>`;
  }

  // ── Main render ───────────────────────────────────────────────

  protected override render() {
    const merged = this._merged;
    const turns = groupIntoTurns(merged);

    return html`
      <div class="header">
        <div class="header-left">
          <span>Process:</span>
          <span class="proc-name">${this._processLabel()}</span>
        </div>
        <div class="header-right">
          <label class="autoscroll-label">
            <input type="checkbox" class="autoscroll-cb" .checked=${this.autoscroll} @change=${this._onAutoscrollChange} />
            autoscroll
          </label>
          <button class="clear-btn" @click=${this._onClear}>Clear</button>
        </div>
      </div>
      ${turns.length === 0
        ? html`<div class="empty-state">No output</div>`
        : html`
            <div class="scroll">
              <div class="col-legend">
                <span>time</span>
                <span>agent</span>
                <span>output</span>
              </div>
              ${turns.map(turn => this._renderTurn(turn))}
              <div class="cursor-row"><span class="cursor-blink"></span></div>
            </div>
          `}
    `;
  }

  private _renderTurn(turn: Turn) {
    const color = agentColor(turn.processName);
    const key = turn.lines[0]?.seq ?? 0;
    const collapsed = this._collapsedTurns.has(key);
    const visibleLines = turn.lines.filter(l => isToolCard(l) || !shouldHide(l));
    const lineCount = visibleLines.length;

    if (collapsed) {
      const first = visibleLines[0] ?? turn.lines[0];
      return html`
        <div class="row group-start">
          <span class="col-time">${formatTime(turn.startTime)}</span>
          <span class="col-agent clickable" style="color:${color}" @click=${(e: Event) => this._toggleTurn(key, e)}>
            <span class="dot" style="background:${color}"></span>
            <span class="name">${turn.processName}</span>
            ${lineCount > 1 ? html`<span class="more-badge">+${lineCount - 1}</span>` : nothing}
          </span>
          <div class="col-content">${this._renderItem(first)}</div>
        </div>
      `;
    }

    return html`${turn.lines.map((line, i) => {
      if (!isToolCard(line) && shouldHide(line)) return nothing;
      const isFirst = i === 0;
      return html`
        <div class="row ${isFirst ? "group-start" : ""}">
          <span class="col-time">${isFirst ? formatTime(turn.startTime) : ""}</span>
          <span class="col-agent ${isFirst ? "clickable" : ""}" style="color:${color}"
            @click=${isFirst ? () => this._toggleTurn(key) : null}>
            ${isFirst
              ? html`<span class="dot" style="background:${color}"></span><span class="name">${turn.processName}</span>`
              : nothing}
          </span>
          <div class="col-content">${this._renderItem(line)}</div>
        </div>
      `;
    })}`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "lens-terminal-view": LensTerminalView;
  }
}
