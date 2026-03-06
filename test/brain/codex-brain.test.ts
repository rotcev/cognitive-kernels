import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const {
  codexConstructorMock,
  startThreadMock,
  resumeThreadMock,
  threadMock,
} = vi.hoisted(() => {
  const thread = {
    id: "thread-1",
    run: vi.fn(),
    runStreamed: vi.fn(),
  };

  return {
    codexConstructorMock: vi.fn(),
    startThreadMock: vi.fn(() => thread),
    resumeThreadMock: vi.fn(() => thread),
    threadMock: thread,
  };
});

vi.mock("@openai/codex-sdk", () => ({
  Codex: class MockCodex {
    constructor(options?: unknown) {
      codexConstructorMock(options);
    }

    startThread(options?: unknown) {
      return startThreadMock(options);
    }

    resumeThread(_id: string, options?: unknown) {
      return resumeThreadMock(options);
    }
  },
}));

import { CodexBrain } from "../../src/brain/codex-brain.js";
import { prepareCodexCliEnvironment } from "../../src/brain/codex-brain.js";

const originalEnv = { ...process.env };

function createTempDir(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createTempCodexHome(prefix: string): string {
  const codexHome = createTempDir(prefix);
  writeFileSync(path.join(codexHome, "auth.json"), "{\"token\":\"test\"}\n", "utf8");
  return codexHome;
}

describe("CodexBrain", () => {
  beforeEach(() => {
    codexConstructorMock.mockClear();
    startThreadMock.mockClear();
    resumeThreadMock.mockClear();
    threadMock.run.mockReset();
    threadMock.runStreamed.mockReset();
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }

    for (const [key, value] of Object.entries(originalEnv)) {
      process.env[key] = value;
    }
  });

  test("scrubs ambient Codex session env and seeds an isolated Codex home", () => {
    const sourceCodexHome = createTempCodexHome("ck-source-");
    const isolatedCodexHome = createTempDir("ck-isolated-");

    process.env.CODEX_THREAD_ID = "desktop-thread";
    process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE = "Codex Desktop";
    process.env.CODEX_SHELL = "1";
    process.env.CODEX_API_KEY = "api-key";

    const env = prepareCodexCliEnvironment(
      {
        ...process.env,
        CUSTOM_FLAG: "1",
      } as Record<string, string>,
      {
        sourceCodexHome,
        isolatedCodexHome,
      },
    );

    expect(env).toMatchObject({
      CODEX_API_KEY: "api-key",
      CODEX_HOME: isolatedCodexHome,
      CUSTOM_FLAG: "1",
    });
    expect(env.CODEX_THREAD_ID).toBeUndefined();
    expect(env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE).toBeUndefined();
    expect(env.CODEX_SHELL).toBeUndefined();
    expect(readFileSync(path.join(isolatedCodexHome, "auth.json"), "utf8")).toContain("test");
    expect(readFileSync(path.join(isolatedCodexHome, "config.toml"), "utf8")).toBe("");

    rmSync(sourceCodexHome, { recursive: true, force: true });
    rmSync(isolatedCodexHome, { recursive: true, force: true });
  });

  test("disables ambient MCP servers on the default Codex client", () => {
    const sourceCodexHome = createTempCodexHome("ck-source-");
    const isolatedCodexHome = createTempDir("ck-isolated-");

    process.env.CODEX_HOME = sourceCodexHome;
    process.env.COGNITIVE_KERNELS_CODEX_HOME = isolatedCodexHome;
    process.env.CODEX_THREAD_ID = "desktop-thread";
    process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE = "Codex Desktop";

    new CodexBrain({
      env: {
        CUSTOM_FLAG: "1",
      },
      config: {
        web_search: "disabled",
      },
    });

    expect(codexConstructorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          CODEX_HOME: isolatedCodexHome,
          CUSTOM_FLAG: "1",
        }),
        config: {
          web_search: "disabled",
          mcp_servers: {},
        },
      }),
    );
    const constructorEnv = codexConstructorMock.mock.calls[0]?.[0] as { env?: Record<string, string> };
    expect(constructorEnv.env?.CODEX_THREAD_ID).toBeUndefined();
    expect(constructorEnv.env?.CODEX_INTERNAL_ORIGINATOR_OVERRIDE).toBeUndefined();

    rmSync(sourceCodexHome, { recursive: true, force: true });
    rmSync(isolatedCodexHome, { recursive: true, force: true });
  });

  test("defaults skipGitRepoCheck to true for fresh working directories", () => {
    const sourceCodexHome = createTempCodexHome("ck-source-");
    const isolatedCodexHome = createTempDir("ck-isolated-");

    process.env.CODEX_HOME = sourceCodexHome;
    process.env.COGNITIVE_KERNELS_CODEX_HOME = isolatedCodexHome;

    const brain = new CodexBrain({});

    brain.startThread({
      model: "gpt-5.3-codex",
      workingDirectory: "/tmp/non-git-workspace",
      sandboxMode: "workspace-write",
    });

    expect(startThreadMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-5.3-codex",
        workingDirectory: "/tmp/non-git-workspace",
        sandboxMode: "workspace-write",
        skipGitRepoCheck: true,
      }),
    );

    rmSync(sourceCodexHome, { recursive: true, force: true });
    rmSync(isolatedCodexHome, { recursive: true, force: true });
  });

  test("preserves an explicit skipGitRepoCheck=false override", () => {
    const sourceCodexHome = createTempCodexHome("ck-source-");
    const isolatedCodexHome = createTempDir("ck-isolated-");

    process.env.CODEX_HOME = sourceCodexHome;
    process.env.COGNITIVE_KERNELS_CODEX_HOME = isolatedCodexHome;

    const brain = new CodexBrain({});

    brain.startThread({
      model: "gpt-5.3-codex",
      workingDirectory: "/tmp/git-workspace",
      skipGitRepoCheck: false,
    });

    expect(startThreadMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workingDirectory: "/tmp/git-workspace",
        skipGitRepoCheck: false,
      }),
    );

    rmSync(sourceCodexHome, { recursive: true, force: true });
    rmSync(isolatedCodexHome, { recursive: true, force: true });
  });

  test("emits normalized MCP tool lifecycle events while streaming", async () => {
    const sourceCodexHome = createTempCodexHome("ck-source-");
    const isolatedCodexHome = createTempDir("ck-isolated-");

    process.env.CODEX_HOME = sourceCodexHome;
    process.env.COGNITIVE_KERNELS_CODEX_HOME = isolatedCodexHome;

    threadMock.runStreamed.mockResolvedValue({
      events: (async function* () {
        yield {
          type: "item.started",
          item: {
            id: "tool-1",
            type: "mcp_tool_call",
            server: "concurrent-browser",
            tool: "browser_create_instance",
            arguments: {
              headless: false,
              viewport: { width: 1440, height: 900 },
            },
            status: "in_progress",
          },
        };
        yield {
          type: "item.updated",
          item: {
            id: "tool-1",
            type: "mcp_tool_call",
            server: "concurrent-browser",
            tool: "browser_create_instance",
            arguments: {
              headless: false,
              viewport: { width: 1440, height: 900 },
            },
            status: "in_progress",
          },
        };
        yield {
          type: "item.completed",
          item: {
            id: "tool-1",
            type: "mcp_tool_call",
            server: "concurrent-browser",
            tool: "browser_create_instance",
            arguments: {
              headless: false,
            },
            result: {
              content: [],
              structured_content: {
                instanceId: "browser-1",
                headless: false,
              },
            },
            status: "completed",
          },
        };
        yield {
          type: "item.completed",
          item: {
            id: "msg-1",
            type: "agent_message",
            text: "browser ok",
          },
        };
        yield {
          type: "turn.completed",
          usage: {
            input_tokens: 10,
            cached_input_tokens: 0,
            output_tokens: 5,
          },
        };
      })(),
    });

    const brain = new CodexBrain({});
    const thread = brain.startThread();
    const events: unknown[] = [];

    const result = await thread.run("browser check", {
      onStreamEvent: (event) => events.push(event),
    });

    expect(result.finalResponse).toBe("browser ok");
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool_started",
          provider: "codex",
          toolName: "concurrent-browser:browser_create_instance",
          toolUseId: "tool-1",
          argumentsSummary: expect.objectContaining({
            headless: false,
          }),
        }),
        expect.objectContaining({
          type: "tool_progress",
          provider: "codex",
          toolName: "concurrent-browser:browser_create_instance",
          toolUseId: "tool-1",
          argumentsSummary: expect.objectContaining({
            headless: false,
          }),
        }),
        expect.objectContaining({
          type: "tool_completed",
          provider: "codex",
          toolName: "concurrent-browser:browser_create_instance",
          toolUseId: "tool-1",
          resultSummary: expect.objectContaining({
            structured_content: expect.objectContaining({
              headless: false,
            }),
          }),
        }),
      ]),
    );

    rmSync(sourceCodexHome, { recursive: true, force: true });
    rmSync(isolatedCodexHome, { recursive: true, force: true });
  });
});
