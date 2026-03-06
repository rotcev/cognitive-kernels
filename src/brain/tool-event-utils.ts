import type { StreamEventValue } from "../types.js";

const REDACTED_VALUE = "[redacted]";
const CIRCULAR_VALUE = "[circular]";
const TRUNCATED_VALUE = "[truncated]";
const MAX_DEPTH = 4;
const MAX_ARRAY_ITEMS = 8;
const MAX_OBJECT_KEYS = 16;
const MAX_STRING_LENGTH = 240;
const SENSITIVE_KEY_PATTERN = /(api[_-]?key|token|secret|authorization|cookie|password|passwd|session)/i;

function summarizeString(value: string): string {
  return value.length <= MAX_STRING_LENGTH
    ? value
    : `${value.slice(0, MAX_STRING_LENGTH)}…`;
}

function summarizeObject(
  value: Record<string, unknown>,
  depth: number,
  seen: WeakSet<object>,
): StreamEventValue {
  if (seen.has(value)) {
    return CIRCULAR_VALUE;
  }
  seen.add(value);

  const summary: Record<string, StreamEventValue> = {};
  const entries = Object.entries(value);
  const limitedEntries = entries.slice(0, MAX_OBJECT_KEYS);

  for (const [key, nestedValue] of limitedEntries) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      summary[key] = REDACTED_VALUE;
      continue;
    }

    const nestedSummary = summarizeToolValue(nestedValue, depth + 1, seen);
    if (nestedSummary !== undefined) {
      summary[key] = nestedSummary;
    }
  }

  if (entries.length > MAX_OBJECT_KEYS) {
    summary._truncated = `${TRUNCATED_VALUE} ${entries.length - MAX_OBJECT_KEYS} keys`;
  }

  return summary;
}

export function summarizeToolValue(
  value: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet(),
): StreamEventValue | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return summarizeString(value);
  }
  if (typeof value === "bigint") {
    return summarizeString(value.toString());
  }
  if (typeof value === "function" || typeof value === "symbol") {
    return summarizeString(String(value));
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: summarizeString(value.message),
    };
  }
  if (depth >= MAX_DEPTH) {
    return TRUNCATED_VALUE;
  }
  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => summarizeToolValue(item, depth + 1, seen))
      .filter((item): item is StreamEventValue => item !== undefined);

    if (value.length > MAX_ARRAY_ITEMS) {
      items.push(`${TRUNCATED_VALUE} ${value.length - MAX_ARRAY_ITEMS} items`);
    }

    return items;
  }
  if (typeof value === "object") {
    if ("type" in value && (value as { type?: unknown }).type === "Buffer" && "data" in value) {
      const data = (value as { data?: unknown }).data;
      const length = Array.isArray(data) ? data.length : undefined;
      return length === undefined ? "[Buffer]" : `[Buffer ${length} bytes]`;
    }

    return summarizeObject(value as Record<string, unknown>, depth, seen);
  }

  return summarizeString(String(value));
}

function extractErrorMessage(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.message === "string") {
    return summarizeString(record.message);
  }
  if (typeof record.error === "string") {
    return summarizeString(record.error);
  }
  if (record.error && typeof record.error === "object" && !Array.isArray(record.error)) {
    const nested = record.error as Record<string, unknown>;
    if (typeof nested.message === "string") {
      return summarizeString(nested.message);
    }
  }

  return undefined;
}

export function summarizeToolError(value: unknown): string {
  return extractErrorMessage(value)
    ?? (summarizeToolValue(value) !== undefined ? JSON.stringify(summarizeToolValue(value)) : "unknown tool error");
}

export function isLikelyToolFailure(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  if (record.is_error === true || record.isError === true || record.ok === false || record.success === false) {
    return true;
  }

  const status = record.status;
  return status === "failed" || status === "error";
}
