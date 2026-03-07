/**
 * Narrative generator — produces human-readable status summaries from Lens snapshots.
 *
 * Designed for cheap/fast models (Haiku-tier). The generator is pluggable:
 * pass any `generate(prompt) => string` function. A built-in Anthropic Haiku
 * adapter is provided (zero extra deps, uses raw fetch).
 *
 * Throttled: narratives are generated at most once per interval, and only
 * when the snapshot has meaningfully changed.
 */

import type { LensSnapshot, LensSnapshotDelta } from "./types.js";

// ── Types ────────────────────────────────────────────────────────

export type NarrativeGenerateFn = (prompt: string) => Promise<string>;

export interface NarrativeGeneratorOptions {
  generate: NarrativeGenerateFn;
  /** Minimum ms between narrative generations. Default: 5000. */
  throttleMs?: number;
  /** Max tokens for the LLM response. Default: 150. */
  maxTokens?: number;
}

export interface NarrativeResult {
  runId: string;
  text: string;
  generatedAt: string;
}

// ── Generator ────────────────────────────────────────────────────

export class NarrativeGenerator {
  private readonly generate: NarrativeGenerateFn;
  private readonly throttleMs: number;
  private readonly maxTokens: number;

  private lastGeneratedAt = 0;
  private lastTick = -1;
  private pending = false;

  constructor(options: NarrativeGeneratorOptions) {
    this.generate = options.generate;
    this.throttleMs = options.throttleMs ?? 5000;
    this.maxTokens = options.maxTokens ?? 150;
  }

  /**
   * Generate a narrative from a full snapshot.
   * Returns null if throttled or snapshot hasn't changed meaningfully.
   */
  async fromSnapshot(snapshot: LensSnapshot): Promise<NarrativeResult | null> {
    if (!this.shouldGenerate(snapshot.tick)) return null;

    const prompt = buildSnapshotPrompt(snapshot);
    return this.run(snapshot.runId, prompt, snapshot.tick);
  }

  /**
   * Generate a narrative from a delta (uses the current snapshot for context).
   * Returns null if throttled.
   */
  async fromDelta(snapshot: LensSnapshot, delta: LensSnapshotDelta): Promise<NarrativeResult | null> {
    if (!this.shouldGenerate(delta.tick)) return null;

    const prompt = buildDeltaPrompt(snapshot, delta);
    return this.run(snapshot.runId, prompt, delta.tick);
  }

  private shouldGenerate(tick: number): boolean {
    const now = Date.now();
    if (this.pending) return false;
    if (tick === this.lastTick) return false;
    if (now - this.lastGeneratedAt < this.throttleMs) return false;
    return true;
  }

  private async run(runId: string, prompt: string, tick: number): Promise<NarrativeResult | null> {
    this.pending = true;
    this.lastTick = tick;
    try {
      const text = await this.generate(prompt);
      this.lastGeneratedAt = Date.now();
      return {
        runId,
        text: text.trim(),
        generatedAt: new Date().toISOString(),
      };
    } catch {
      return null;
    } finally {
      this.pending = false;
    }
  }
}

// ── Prompt builders ──────────────────────────────────────────────

const SYSTEM_INSTRUCTION = [
  "You are a concise status narrator for an AI execution system.",
  "Write 1-2 sentences describing what's happening RIGHT NOW.",
  "Use present tense. Be specific about process names and actions.",
  "Never mention internal system details like PIDs, tokens, or ticks.",
  "Write for a non-technical user who wants to know: what is the system doing?",
].join(" ");

function buildSnapshotPrompt(snap: LensSnapshot): string {
  const running = snap.processes.filter(p => p.state === "running");
  const sleeping = snap.processes.filter(p => p.state === "sleeping");
  const dead = snap.processes.filter(p => p.state === "dead");

  const bbKeys = Object.keys(snap.blackboard);
  const bbSummary = bbKeys.length > 0
    ? `Shared data: ${bbKeys.slice(0, 5).join(", ")}${bbKeys.length > 5 ? ` (+${bbKeys.length - 5} more)` : ""}`
    : "No shared data yet.";

  const lines = [
    `[System] ${SYSTEM_INSTRUCTION}`,
    "",
    `Goal: "${snap.goal}"`,
    `Elapsed: ${formatMs(snap.elapsed)}`,
    `Active processes (${running.length}): ${running.map(p => `${p.name} — ${p.objective}`).join("; ") || "none"}`,
  ];

  if (sleeping.length > 0) {
    lines.push(`Waiting (${sleeping.length}): ${sleeping.map(p => p.name).join(", ")}`);
  }
  if (dead.length > 0) {
    lines.push(`Completed (${dead.length}): ${dead.map(p => `${p.name}${p.exitReason ? ` (${p.exitReason})` : ""}`).join(", ")}`);
  }

  lines.push(bbSummary);

  if (snap.deferrals.length > 0) {
    lines.push(`Deferred work: ${snap.deferrals.map(d => d.reason).join("; ")}`);
  }

  lines.push("", "Narrate the current status:");

  return lines.join("\n");
}

function buildDeltaPrompt(snap: LensSnapshot, delta: LensSnapshotDelta): string {
  const changes: string[] = [];

  if (delta.processes) {
    for (const added of delta.processes.added) {
      changes.push(`New process started: ${added.name} — ${added.objective}`);
    }
    for (const pid of delta.processes.removed) {
      const proc = snap.processes.find(p => p.pid === pid);
      changes.push(`Process ended: ${proc?.name ?? pid}`);
    }
    for (const ch of delta.processes.changed) {
      const proc = snap.processes.find(p => p.pid === ch.pid);
      if (ch.changed.state) {
        changes.push(`${proc?.name ?? ch.pid} is now ${ch.changed.state}`);
      }
    }
  }

  if (delta.blackboard) {
    for (const entry of delta.blackboard.updated) {
      changes.push(`New result written: "${entry.key}" by ${entry.writer}`);
    }
  }

  if (changes.length === 0) {
    changes.push("Minor internal progress, no significant state changes.");
  }

  const lines = [
    `[System] ${SYSTEM_INSTRUCTION}`,
    "",
    `Goal: "${snap.goal}"`,
    `Elapsed: ${formatMs(snap.elapsed)}`,
    `Recent changes:`,
    ...changes.map(c => `  - ${c}`),
    "",
    "Narrate what just happened:",
  ];

  return lines.join("\n");
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return rem > 0 ? `${mins}m ${rem}s` : `${mins}m`;
}

// ── Anthropic Haiku adapter (zero deps) ──────────────────────────

export function createAnthropicNarrator(options: {
  apiKey?: string;
  model?: string;
  maxTokens?: number;
}): NarrativeGenerateFn {
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is required for the Anthropic narrator");
  }

  const model = options.model ?? "claude-haiku-4-5-20251001";
  const maxTokens = options.maxTokens ?? 150;

  return async (prompt: string): Promise<string> => {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      throw new Error(`Anthropic API error: ${response.status}`);
    }

    const data = await response.json() as {
      content: Array<{ type: string; text?: string }>;
    };

    const textBlock = data.content.find(b => b.type === "text");
    return textBlock?.text ?? "";
  };
}

// ── OpenAI adapter (for codex provider setups) ───────────────────

export function createOpenAINarrator(options: {
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  baseUrl?: string;
}): NarrativeGenerateFn {
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required for the OpenAI narrator");
  }

  const model = options.model ?? "gpt-4o-mini";
  const maxTokens = options.maxTokens ?? 150;
  const baseUrl = options.baseUrl ?? "https://api.openai.com/v1";

  return async (prompt: string): Promise<string> => {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status}`);
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
    };

    return data.choices[0]?.message?.content ?? "";
  };
}
