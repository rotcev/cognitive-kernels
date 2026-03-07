import { html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { LensElement, lensBaseStyles } from "../tokens/base.js";
import type { LensProcess, LensProcessRole, LensTerminalLine, LensBBEntry } from "../mock/types.js";

import "./terminal-view.js";

type DrawerTab = "info" | "terminal" | "blackboard" | "messages";

const roleColors: Record<LensProcessRole, { fg: string; bg: string; border: string }> = {
  kernel: { fg: "var(--lens-accent)", bg: "var(--lens-accent-dim)", border: "var(--lens-accent)" },
  "sub-kernel": { fg: "var(--lens-cyan)", bg: "var(--lens-cyan-dim)", border: "var(--lens-cyan)" },
  worker: { fg: "var(--lens-gray)", bg: "var(--lens-gray-dim)", border: "var(--lens-gray)" },
  shell: { fg: "var(--lens-gray)", bg: "var(--lens-gray-dim)", border: "var(--lens-gray)" },
};

interface Message {
  text: string;
  sent: boolean;
}

@customElement("lens-process-drawer")
export class LensProcessDrawer extends LensElement {
  static override styles = [
    lensBaseStyles,
    css`
      :host {
        display: block;
        position: fixed;
        top: 40px;
        right: 0;
        width: 420px;
        bottom: 32px;
        background: var(--lens-bg-panel);
        border-left: 1px solid var(--lens-border);
        z-index: 200;
        transform: translateX(100%);
        transition: transform var(--lens-transition-med), box-shadow var(--lens-transition-med);
        font-family: var(--lens-font-mono);
        display: flex;
        flex-direction: column;
      }

      :host([open]) {
        transform: translateX(0);
        box-shadow: -4px 0 24px rgba(0, 0, 0, 0.5);
      }

      .header {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 12px 16px;
        border-bottom: 1px solid var(--lens-border);
        flex-shrink: 0;
      }

      .proc-name {
        font-size: 14px;
        font-weight: 600;
        color: var(--lens-accent);
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .role-badge {
        font-size: 9px;
        padding: 1px 5px;
        border-radius: var(--lens-radius-sm);
        border-width: 1px;
        border-style: solid;
        line-height: 1.4;
        flex-shrink: 0;
      }

      .header-btn {
        width: 24px;
        height: 24px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: transparent;
        border: 1px solid var(--lens-border);
        border-radius: var(--lens-radius-sm);
        color: var(--lens-text-dim);
        cursor: pointer;
        font-family: var(--lens-font-mono);
        font-size: 12px;
        transition: all var(--lens-transition-fast);
        flex-shrink: 0;
      }

      .header-btn:hover {
        color: var(--lens-text);
        border-color: var(--lens-border-bright);
      }

      .tabs {
        display: flex;
        border-bottom: 1px solid var(--lens-border);
        flex-shrink: 0;
      }

      .tab {
        flex: 1;
        padding: 8px 0;
        font-family: var(--lens-font-mono);
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        text-align: center;
        color: var(--lens-text-dim);
        background: transparent;
        border: none;
        border-bottom: 2px solid transparent;
        cursor: pointer;
        transition: all var(--lens-transition-fast);
      }

      .tab:hover {
        color: var(--lens-text-secondary);
      }

      .tab.active {
        color: var(--lens-accent);
        border-bottom-color: var(--lens-accent);
      }

      .tab-content {
        flex: 1;
        overflow-y: auto;
        padding: 12px 16px;
      }

      .tab-content.terminal-tab {
        padding: 0;
        overflow: hidden;
      }

      .tab-content.terminal-tab lens-terminal-view {
        height: 100%;
      }

      /* Info tab */
      .info-section {
        margin-bottom: 12px;
      }

      .info-label {
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--lens-text-dim);
        margin-bottom: 2px;
      }

      .info-value {
        font-size: 12px;
        color: var(--lens-text);
      }

      .token-bar-container {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .token-bar {
        flex: 1;
        height: 4px;
        background: var(--lens-bg-surface);
        border-radius: 2px;
        overflow: hidden;
      }

      .token-bar-fill {
        height: 100%;
        background: var(--lens-accent);
        border-radius: 2px;
        transition: width 0.3s ease;
      }

      .token-bar-label {
        font-size: 10px;
        color: var(--lens-text-dim);
        flex-shrink: 0;
      }

      /* Messages tab */
      .messages-area {
        flex: 1;
        display: flex;
        flex-direction: column;
        height: 100%;
      }

      .messages-thread {
        flex: 1;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding-bottom: 8px;
      }

      .bubble {
        max-width: 85%;
        padding: 6px 10px;
        font-size: 11px;
        line-height: 1.5;
        border-radius: var(--lens-radius-md);
        word-break: break-word;
      }

      .bubble.sent {
        align-self: flex-end;
        background: var(--lens-accent-dim);
        color: var(--lens-accent);
      }

      .bubble.received {
        align-self: flex-start;
        background: var(--lens-bg-elevated);
        color: var(--lens-text-secondary);
      }

      .msg-input-row {
        display: flex;
        gap: 6px;
        padding-top: 8px;
        border-top: 1px solid var(--lens-border);
        flex-shrink: 0;
      }

      .msg-textarea {
        flex: 1;
        font-family: var(--lens-font-mono);
        font-size: 11px;
        padding: 6px 8px;
        background: var(--lens-bg-surface);
        border: 1px solid var(--lens-border);
        border-radius: var(--lens-radius-sm);
        color: var(--lens-text);
        resize: none;
        outline: none;
        min-height: 32px;
        max-height: 80px;
      }

      .msg-textarea:focus {
        border-color: var(--lens-accent);
      }

      .send-btn {
        font-family: var(--lens-font-mono);
        font-size: 10px;
        padding: 4px 12px;
        background: var(--lens-accent-dim);
        border: 1px solid var(--lens-accent);
        border-radius: var(--lens-radius-sm);
        color: var(--lens-accent);
        cursor: pointer;
        transition: all var(--lens-transition-fast);
        align-self: flex-end;
      }

      .send-btn:hover {
        background: var(--lens-accent);
        color: var(--lens-bg-root);
      }

      .placeholder {
        color: var(--lens-text-dim);
        font-size: 12px;
        text-align: center;
        padding-top: 40px;
      }
    `,
  ];

  @property({ type: Object }) process: LensProcess | null = null;
  @property({ type: Boolean, reflect: true }) open = false;
  @property({ type: Array }) terminalLines: LensTerminalLine[] = [];
  @property({ type: Object }) blackboard: Record<string, LensBBEntry> = {};

  @state() private _activeTab: DrawerTab = "info";
  @state() private _messages: Message[] = [
    { text: "Process initialized successfully.", sent: false },
  ];
  @state() private _msgDraft = "";

  private _close() {
    this.dispatchEvent(new CustomEvent("close", { bubbles: true, composed: true }));
  }

  private _expand() {
    this.dispatchEvent(new CustomEvent("expand", { bubbles: true, composed: true }));
  }

  private _setTab(tab: DrawerTab) {
    this._activeTab = tab;
    this.dispatchEvent(
      new CustomEvent("tab-change", { detail: { tab }, bubbles: true, composed: true })
    );
  }

  private _sendMessage() {
    const text = this._msgDraft.trim();
    if (!text) return;
    this._messages = [...this._messages, { text, sent: true }];
    this._msgDraft = "";
    this.dispatchEvent(
      new CustomEvent("send-message", { detail: { text }, bubbles: true, composed: true })
    );
  }

  private _renderInfo() {
    const p = this.process;
    if (!p) return nothing;

    const tokenPct = p.tokenBudget ? Math.min((p.tokensUsed / p.tokenBudget) * 100, 100) : null;

    return html`
      <div class="info-section">
        <div class="info-label">PID</div>
        <div class="info-value">${p.pid}</div>
      </div>
      <div class="info-section">
        <div class="info-label">Objective</div>
        <div class="info-value">${p.objective}</div>
      </div>
      <div class="info-section">
        <div class="info-label">Model</div>
        <div class="info-value">${p.model}</div>
      </div>
      <div class="info-section">
        <div class="info-label">Priority</div>
        <div class="info-value">${p.priority}</div>
      </div>
      <div class="info-section">
        <div class="info-label">State</div>
        <div class="info-value">${p.state}</div>
      </div>
      <div class="info-section">
        <div class="info-label">Ticks</div>
        <div class="info-value">${p.tickCount}</div>
      </div>
      <div class="info-section">
        <div class="info-label">Tokens</div>
        ${tokenPct !== null
          ? html`
              <div class="token-bar-container">
                <div class="info-value">${p.tokensUsed.toLocaleString()}</div>
                <div class="token-bar">
                  <div class="token-bar-fill" style="width: ${tokenPct}%"></div>
                </div>
                <span class="token-bar-label">${p.tokenBudget!.toLocaleString()}</span>
              </div>
            `
          : html`<div class="info-value">${p.tokensUsed.toLocaleString()}</div>`}
      </div>
    `;
  }

  private get _processTerminalLines(): LensTerminalLine[] {
    if (!this.process) return [];
    return this.terminalLines.filter(l => l.pid === this.process!.pid);
  }

  private get _processBlackboardEntries(): Record<string, LensBBEntry> {
    if (!this.process) return {};
    const result: Record<string, LensBBEntry> = {};
    const written = new Set(this.process.blackboardIO
      .filter(io => io.direction === "write")
      .map(io => io.key));
    for (const [key, entry] of Object.entries(this.blackboard)) {
      if (written.has(key) || entry.writer === this.process.name) {
        result[key] = entry;
      }
    }
    return result;
  }

  private _renderTerminal() {
    const lines = this._processTerminalLines;
    if (lines.length === 0) {
      return html`<div class="placeholder">No terminal output for ${this.process?.name ?? "unknown"}</div>`;
    }
    return html`<lens-terminal-view .lines=${lines} processFilter=${this.process?.pid ?? ""} ?compact=${true}></lens-terminal-view>`;
  }

  private _renderBlackboard() {
    const entries = this._processBlackboardEntries;
    const keys = Object.keys(entries);
    if (keys.length === 0) {
      return html`<div class="placeholder">No blackboard entries for ${this.process?.name ?? "unknown"}</div>`;
    }
    return html`
      <div class="bb-entries">
        ${keys.map(key => {
          const entry = entries[key];
          return html`
            <div class="info-section">
              <div class="info-label">${key}</div>
              <div class="info-value" style="font-size:10px; white-space:pre-wrap; word-break:break-word;">${typeof entry.value === "string" ? entry.value : JSON.stringify(entry.value, null, 2)}</div>
            </div>
          `;
        })}
      </div>
    `;
  }

  private _renderMessages() {
    return html`
      <div class="messages-area">
        <div class="messages-thread">
          ${this._messages.map(
            (m) => html`<div class="bubble ${m.sent ? "sent" : "received"}">${m.text}</div>`
          )}
        </div>
        <div class="msg-input-row">
          <textarea
            class="msg-textarea"
            rows="1"
            placeholder="Send a message..."
            .value=${this._msgDraft}
            @input=${(e: Event) => {
              this._msgDraft = (e.target as HTMLTextAreaElement).value;
            }}
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                this._sendMessage();
              }
            }}
          ></textarea>
          <button class="send-btn" @click=${this._sendMessage}>Send</button>
        </div>
      </div>
    `;
  }

  protected override render() {
    if (!this.process) return nothing;

    const rc = roleColors[this.process.role];
    const tabs: DrawerTab[] = ["info", "terminal", "blackboard", "messages"];

    return html`
      <div class="header">
        <span class="proc-name">${this.process.name}</span>
        <span
          class="role-badge"
          style="color: ${rc.fg}; background: ${rc.bg}; border-color: ${rc.border};"
        >${this.process.role}</span>
        <button class="header-btn" @click=${this._expand} title="Expand">\u2197</button>
        <button class="header-btn" @click=${this._close} title="Close">\u2715</button>
      </div>
      <div class="tabs">
        ${tabs.map(
          (tab) => html`
            <button
              class="tab ${this._activeTab === tab ? "active" : ""}"
              @click=${() => this._setTab(tab)}
            >
              ${tab}
            </button>
          `
        )}
      </div>
      <div class="tab-content ${this._activeTab === "terminal" ? "terminal-tab" : ""}">
        ${this._activeTab === "info" ? this._renderInfo() : nothing}
        ${this._activeTab === "terminal" ? this._renderTerminal() : nothing}
        ${this._activeTab === "blackboard" ? this._renderBlackboard() : nothing}
        ${this._activeTab === "messages" ? this._renderMessages() : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "lens-process-drawer": LensProcessDrawer;
  }
}
