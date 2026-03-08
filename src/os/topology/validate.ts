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
  switch (expr.type) {
    case "task":
      names.push(expr.name);
      break;
    case "seq":
    case "par":
      for (const child of expr.children) collectNames(child, names);
      break;
    case "gate":
      collectNames(expr.child, names);
      break;
  }
}

function collectErrors(expr: TopologyExpr, path: string, errors: TopologyValidationError[]): void {
  switch (expr.type) {
    case "task": {
      if (!expr.name || expr.name.trim() === "") {
        errors.push({ path, message: "task name must not be empty" });
      }
      if (!expr.objective || expr.objective.trim() === "") {
        errors.push({ path, message: "task objective must not be empty" });
      }
      break;
    }
    case "seq":
    case "par": {
      if (expr.children.length === 0) {
        errors.push({ path, message: `${expr.type} must have at least one child` });
      }
      for (let i = 0; i < expr.children.length; i++) {
        collectErrors(expr.children[i], `${path}.${expr.type}[${i}]`, errors);
      }
      break;
    }
    case "gate": {
      collectErrors(expr.child, `${path}.gate`, errors);
      break;
    }
  }
}
