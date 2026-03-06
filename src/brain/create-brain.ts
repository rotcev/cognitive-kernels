import { type CodexOptions } from "@openai/codex-sdk";
import { ClaudeBrain } from "./claude-brain.js";
import { CodexBrain } from "./codex-brain.js";
import type { Brain, BrainRuntimeConfig, McpServerConfig } from "../types.js";

function mergedEnv(overrides: Record<string, string>): Record<string, string> | undefined {
  if (Object.keys(overrides).length === 0) {
    return undefined;
  }

  const baseEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      baseEnv[key] = value;
    }
  }

  return {
    ...baseEnv,
    ...overrides
  };
}

type CodexConfigValue = string | number | boolean | CodexConfigValue[] | { [key: string]: CodexConfigValue };

function toCodexConfigValue(value: unknown, path: string): CodexConfigValue {
  if (typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`Codex config value at ${path} must be a finite number`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => toCodexConfigValue(item, `${path}[${index}]`));
  }
  if (value && typeof value === "object") {
    const result: { [key: string]: CodexConfigValue } = {};
    for (const [key, child] of Object.entries(value)) {
      result[key] = toCodexConfigValue(child, `${path}.${key}`);
    }
    return result;
  }
  throw new Error(`Unsupported Codex config value at ${path}`);
}

function toCodexConfigObject(
  config: Record<string, unknown>
): NonNullable<CodexOptions["config"]> | undefined {
  if (Object.keys(config).length === 0) {
    return undefined;
  }

  const normalized: Record<string, CodexConfigValue> = {};
  for (const [key, value] of Object.entries(config)) {
    normalized[key] = toCodexConfigValue(value, key);
  }
  return normalized;
}

export function createBrain(
  config: BrainRuntimeConfig,
  browserMcpServers?: Record<string, McpServerConfig>,
): Brain {
  if (config.provider === "claude") {
    return new ClaudeBrain(config);
  }

  const options: CodexOptions = {
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    env: mergedEnv(config.env),
    config: toCodexConfigObject(config.config),
  };

  return new CodexBrain(options, browserMcpServers);
}
