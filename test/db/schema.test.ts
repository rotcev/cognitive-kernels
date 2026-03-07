import { describe, expect, test } from "vitest";

const SCHEMA_MODULE_PATH = "../../src/db/schema.js";

async function importSchemaContract() {
  try {
    return await import(SCHEMA_MODULE_PATH);
  } catch (error) {
    throw new Error(
      `Missing implementation for contract:db-schema. Expected module ${SCHEMA_MODULE_PATH}.`,
      { cause: error as Error },
    );
  }
}

describe("contract:db-schema", () => {
  test("exports schema version and planner", async () => {
    const schema = await importSchemaContract();

    expect(schema).toHaveProperty("CURRENT_SCHEMA_VERSION");
    expect(typeof schema.CURRENT_SCHEMA_VERSION).toBe("number");
    expect(Number.isInteger(schema.CURRENT_SCHEMA_VERSION)).toBe(true);
    expect(schema.CURRENT_SCHEMA_VERSION).toBeGreaterThan(0);

    expect(schema).toHaveProperty("buildSchemaPlan");
    expect(typeof schema.buildSchemaPlan).toBe("function");
  });
});
