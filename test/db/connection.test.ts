import { describe, expect, test } from "vitest";

const CONNECTION_MODULE_PATH = "../../src/db/connection.js";

async function importConnectionContract() {
  try {
    return await import(CONNECTION_MODULE_PATH);
  } catch (error) {
    throw new Error(
      `Missing implementation for contract:db-connection. Expected module ${CONNECTION_MODULE_PATH}.`,
      { cause: error as Error },
    );
  }
}

describe("contract:db-connection", () => {
  test("exports connection lifecycle helpers", async () => {
    const connection = await importConnectionContract();

    expect(connection).toHaveProperty("connectStorage");
    expect(typeof connection.connectStorage).toBe("function");

    expect(connection).toHaveProperty("disconnectStorage");
    expect(typeof connection.disconnectStorage).toBe("function");
  });
});
