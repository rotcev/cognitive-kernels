import { beforeEach, describe, expect, test, vi } from "vitest";

const { mockReadFile, runKernelMock, capture } = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
  runKernelMock: vi.fn(async () => ({
    runId: "run-1",
    goal: "test goal",
    halted: true,
    haltReason: "test",
    config: { kernel: { tokenBudget: 100000 } },
    processes: new Map(),
    blackboard: new Map(),
    tickCount: 0,
    dagTopology: { nodes: [], edges: [] },
    schedulerHeuristics: [],
    startTime: Date.now(),
  })),
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

// Mock OsKernel (still imported but no longer used in the main path)
vi.mock("../../src/os/kernel.js", () => ({
  OsKernel: class MockOsKernel {
    constructor() {}
    run() {
      return Promise.resolve({});
    }
  },
}));

// Mock runKernel — the new primary path
vi.mock("../../src/os/run-kernel.js", async (importOriginal) => {
  const original = (await importOriginal()) as any;
  return {
    ...original,
    runKernel: vi.fn(
      async (
        _goal: string,
        config: unknown,
        _brain: unknown,
        _emitter: unknown,
        _options: unknown,
      ) => {
        capture.osConfig = config;
        return runKernelMock();
      },
    ),
  };
});

// Mock ScopedMemoryStore so it doesn't touch the filesystem
vi.mock("../../src/os/scoped-memory-store.js", () => ({
  ScopedMemoryStore: class MockScopedMemoryStore {
    loadHeuristics() {}
    loadBlueprints() {}
    hasNewEpisodicData() {
      return false;
    }
    getAll() {
      return [];
    }
  },
}));

import { runOsMode } from "../../src/os/entry.js";

describe("runOsMode", () => {
  beforeEach(() => {
    capture.osConfig = undefined;
    capture.brainConfig = undefined;
    mockReadFile.mockReset();
    runKernelMock.mockClear();
  });

  test("defaults codex provider models to gpt-5.3-codex", async () => {
    await runOsMode({
      goal: "test goal",
      cwd: "/tmp/workspace",
      provider: "codex",
    });

    expect(capture.brainConfig.provider).toBe("codex");
    expect(capture.osConfig.kernel.metacogModel).toBe("gpt-5.3-codex");
    expect(capture.osConfig.kernel.processModel).toBe("gpt-5.3-codex");
    expect(capture.osConfig.awareness.model).toBe("gpt-5.3-codex");
    expect(capture.osConfig.ephemeral.defaultModel).toBe("gpt-5.3-codex");
    expect(capture.osConfig.observation.defaultModel).toBe("gpt-5.3-codex");
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
    expect(capture.osConfig.kernel.processModel).toBe("gpt-5.3-codex");
    expect(capture.osConfig.awareness.model).toBe("gpt-5.3-codex");
    expect(capture.osConfig.ephemeral.defaultModel).toBe("custom-ephemeral");
    expect(capture.osConfig.observation.defaultModel).toBe("gpt-5.3-codex");
  });
});
