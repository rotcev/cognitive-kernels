import type { GateCondition } from "./types.js";

interface BlackboardEntry {
  value: unknown;
  writtenBy?: string;
}

interface ProcessInfo {
  pid: string;
  name: string;
  state: string;
}

/**
 * Evaluate a gate condition against current state.
 * Pure function.
 */
export function evaluateGateCondition(
  condition: GateCondition,
  blackboard: Map<string, BlackboardEntry>,
  processes: Map<string, ProcessInfo>,
): boolean {
  switch (condition.type) {
    case "blackboard_key_exists":
      return blackboard.has(condition.key);

    case "blackboard_key_match": {
      const entry = blackboard.get(condition.key);
      return entry !== undefined && entry.value === condition.value;
    }

    case "blackboard_value_contains": {
      const entry = blackboard.get(condition.key);
      if (!entry) return false;
      const str = typeof entry.value === "string" ? entry.value : JSON.stringify(entry.value);
      return str.includes(condition.substring);
    }

    case "process_dead": {
      for (const proc of processes.values()) {
        if (proc.name === condition.name && proc.state === "dead") return true;
      }
      return false;
    }

    case "all_of":
      return condition.conditions.every(c => evaluateGateCondition(c, blackboard, processes));

    case "any_of":
      return condition.conditions.some(c => evaluateGateCondition(c, blackboard, processes));
  }
}
