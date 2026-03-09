/**
 * McpClient — lightweight MCP client over stdio JSON-RPC.
 *
 * Manages a single MCP server subprocess. The interpreter creates one per
 * configured MCP server (e.g., concurrent-browser-mcp) and routes worker
 * mcp_call commands through it.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpToolResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
}

export class McpClient {
  private proc: ChildProcess | null = null;
  private readonly command: string;
  private readonly args: string[];
  private readonly env: Record<string, string>;

  private pending = new Map<string, {
    resolve: (value: any) => void;
    reject: (reason: any) => void;
  }>();

  private buffer = "";
  private tools: McpTool[] | null = null;
  private connected = false;

  constructor(config: { command: string; args?: string[]; env?: Record<string, string> }) {
    this.command = config.command;
    this.args = config.args ?? [];
    this.env = config.env ?? {};
  }

  /** Start the MCP server subprocess and perform initialization handshake. */
  async connect(): Promise<void> {
    if (this.connected) return;

    this.proc = spawn(this.command, this.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...this.env },
    });

    this.proc.stdout!.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString();
      this.processBuffer();
    });

    this.proc.stderr!.on("data", (chunk: Buffer) => {
      // Log MCP server errors but don't crash
      const msg = chunk.toString().trim();
      if (msg) {
        console.error(`[mcp-client] stderr: ${msg}`);
      }
    });

    this.proc.on("exit", (code) => {
      this.connected = false;
      // Reject all pending requests
      for (const [id, { reject }] of this.pending) {
        reject(new Error(`MCP server exited with code ${code}`));
      }
      this.pending.clear();
    });

    // MCP initialization handshake
    const initResult = await this.sendRequest("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "cognitive-kernel", version: "1.0.0" },
    });

    // Send initialized notification (no response expected)
    this.sendNotification("notifications/initialized", {});

    this.connected = true;
  }

  /** List available tools from the MCP server. */
  async listTools(): Promise<McpTool[]> {
    if (this.tools) return this.tools;
    const result = await this.sendRequest("tools/list", {});
    const tools: McpTool[] = result.tools ?? [];
    this.tools = tools;
    return tools;
  }

  /** Call a tool on the MCP server. */
  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const result = await this.sendRequest("tools/call", { name, arguments: args });
    return result as McpToolResult;
  }

  /** Shut down the MCP server. */
  close(): void {
    this.connected = false;
    if (this.proc) {
      this.proc.stdin!.end();
      this.proc.kill();
      this.proc = null;
    }
    for (const [, { reject }] of this.pending) {
      reject(new Error("MCP client closed"));
    }
    this.pending.clear();
  }

  get isConnected(): boolean {
    return this.connected;
  }

  // ── Private ────────────────────────────────────────────────────

  private sendRequest(method: string, params: Record<string, unknown>): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      this.pending.set(id, { resolve, reject });

      const message = JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        params,
      });

      if (!this.proc?.stdin?.writable) {
        reject(new Error("MCP server stdin not writable"));
        return;
      }

      this.proc.stdin.write(message + "\n");

      // Timeout after 30s
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP request timed out: ${method}`));
        }
      }, 30_000);
    });
  }

  private sendNotification(method: string, params: Record<string, unknown>): void {
    const message = JSON.stringify({
      jsonrpc: "2.0",
      method,
      params,
    });
    this.proc?.stdin?.write(message + "\n");
  }

  private processBuffer(): void {
    // MCP uses newline-delimited JSON-RPC
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const msg = JSON.parse(trimmed);
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);

          if (msg.error) {
            reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
          } else {
            resolve(msg.result);
          }
        }
        // Notifications from server are ignored for now
      } catch {
        // Skip malformed lines
      }
    }
  }
}
