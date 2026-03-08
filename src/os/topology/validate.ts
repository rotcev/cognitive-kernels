import type { TopologyExpr, TopologyValidationResult, TopologyValidationError } from "./types.js";

/**
 * Validate a TopologyExpr for structural soundness.
 * Pure function — runs in microseconds for any realistic topology.
 */
export function validateTopology(expr: TopologyExpr): TopologyValidationResult {
  const errors: TopologyValidationError[] = [];
  collectErrors(expr, "", errors);

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  // Check unique names via flatten
  const names: string[] = [];
  collectNames(expr, names);
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) {
      errors.push({ path: "", message: `duplicate task name: "${name}"` });
    }
    seen.add(name);
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

function collectNames(expr: TopologyExpr, names: string[]): void {
  if (!expr || typeof expr !== "object") return;
  switch (expr.type) {
    case "task":
      if (expr.name) names.push(expr.name);
      break;
    case "seq":
    case "par":
      if (Array.isArray(expr.children)) {
        for (const child of expr.children) collectNames(child, names);
      }
      break;
    case "gate":
      if (expr.child) collectNames(expr.child, names);
      break;
  }
}

function collectErrors(expr: TopologyExpr, path: string, errors: TopologyValidationError[]): void {
  if (!expr || typeof expr !== "object") {
    errors.push({ path, message: "topology node must be an object" });
    return;
  }

  switch (expr.type) {
    case "task": {
      if (!expr.name || typeof expr.name !== "string" || expr.name.trim() === "") {
        errors.push({ path, message: "task name must not be empty" });
      }
      if (!expr.objective || typeof expr.objective !== "string" || expr.objective.trim() === "") {
        errors.push({ path, message: "task objective must not be empty" });
      }
      break;
    }
    case "seq":
    case "par": {
      if (!Array.isArray(expr.children) || expr.children.length === 0) {
        errors.push({ path, message: `${expr.type} must have at least one child` });
        break;
      }
      for (let i = 0; i < expr.children.length; i++) {
        collectErrors(expr.children[i], `${path}.${expr.type}[${i}]`, errors);
      }
      break;
    }
    case "gate": {
      if (!expr.child) {
        errors.push({ path, message: "gate must have a child" });
        break;
      }
      collectErrors(expr.child, `${path}.gate`, errors);
      break;
    }
    default: {
      errors.push({ path, message: `unknown topology node type: "${(expr as any).type}"` });
      break;
    }
  }
}
