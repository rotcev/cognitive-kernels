import { beforeEach, describe, expect, test, vi } from "vitest";

const { mockReadFile, runMock, capture } = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
  runMock: vi.fn(async () => ({ runId: "run-1" })),
  capture: {
    osConfig: undefined as any,
    brainConfig: undefined as any,
  },
}));

vi.mock("node:fs/promises", () => ({
  readFile: mockReadFile,
}));

vi.mock("../../src/brain/create-brain.js", () => ({
  createBrain: vi.fn((brainConfig: unknown) => {
    capture.brainConfig = brainConfig;
    return { startThread: vi.fn() };
  }),
}));

vi.mock("../../src/os/kernel.js", () => ({
  OsKernel: class MockOsKernel {
    constructor(config: unknown) {
      capture.osConfig = config;
    }

    run(goal: string) {
      return runMock(goal);
    }
  },
}));

import { runOsMode } from "../../src/os/entry.js";

describe("runOsMode", () => {
  beforeEach(() => {
    capture.osConfig = undefined;
    capture.brainConfig = undefined;
    mockReadFile.mockReset();
    runMock.mockClear();
  });

  test("defaults codex provider models to gpt-5.4", async () => {
    await runOsMode({
      goal: "test goal",
      cwd: "/tmp/workspace",
      provider: "codex",
    });

    expect(capture.brainConfig.provider).toBe("codex");
    expect(capture.osConfig.kernel.metacogModel).toBe("gpt-5.4");
    expect(capture.osConfig.kernel.processModel).toBe("gpt-5.4");
    expect(capture.osConfig.awareness.model).toBe("gpt-5.4");
    expect(capture.osConfig.ephemeral.defaultModel).toBe("gpt-5.4");
    expect(capture.osConfig.observation.defaultModel).toBe("gpt-5.4");
  });

  test("preserves explicit codex provider model settings from config", async () => {
    mockReadFile.mockResolvedValue(`
[os.kernel]
metacogModel = "custom-metacog"

[os.ephemeral]
defaultModel = "custom-ephemeral"

[codex]
provider = "codex"
`);

    await runOsMode({
      goal: "test goal",
      cwd: "/tmp/workspace",
      configPath: "os.toml",
    });

    expect(capture.brainConfig.provider).toBe("codex");
    expect(capture.osConfig.kernel.metacogModel).toBe("custom-metacog");
    expect(capture.osConfig.kernel.processModel).toBe("gpt-5.4");
    expect(capture.osConfig.awareness.model).toBe("gpt-5.4");
    expect(capture.osConfig.ephemeral.defaultModel).toBe("custom-ephemeral");
    expect(capture.osConfig.observation.defaultModel).toBe("gpt-5.4");
  });
});
