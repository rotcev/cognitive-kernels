import { beforeEach, describe, expect, test, vi } from "vitest";

const { ClaudeBrainMock, CodexBrainMock } = vi.hoisted(() => ({
  ClaudeBrainMock: vi.fn(),
  CodexBrainMock: vi.fn(),
}));

vi.mock("../../src/brain/claude-brain.js", () => ({
  ClaudeBrain: ClaudeBrainMock,
}));

vi.mock("../../src/brain/codex-brain.js", () => ({
  CodexBrain: CodexBrainMock,
}));

import { createBrain } from "../../src/brain/create-brain.js";

describe("createBrain", () => {
  beforeEach(() => {
    ClaudeBrainMock.mockReset();
    CodexBrainMock.mockReset();
  });

  test("uses ClaudeBrain for the claude provider", () => {
    const expected = { kind: "claude-brain" };
    ClaudeBrainMock.mockReturnValue(expected);

    const result = createBrain({
      provider: "claude",
      env: {},
      config: {},
    });

    expect(ClaudeBrainMock).toHaveBeenCalledWith({
      provider: "claude",
      env: {},
      config: {},
    });
    expect(result).toBe(expected);
    expect(CodexBrainMock).not.toHaveBeenCalled();
  });

  test("uses CodexBrain for the codex provider", () => {
    const expected = { kind: "codex-brain" };
    CodexBrainMock.mockReturnValue(expected);

    const browserMcpServers = {
      browser: {
        command: "npx",
        args: ["concurrent-browser-mcp"],
      },
    };

    const result = createBrain(
      {
        provider: "codex",
        baseUrl: "https://api.example.test",
        apiKey: "secret",
        env: { OPENAI_LOG: "1" },
        config: { mode: "strict" },
      },
      browserMcpServers,
    );

    expect(CodexBrainMock).toHaveBeenCalledTimes(1);
    expect(CodexBrainMock.mock.calls[0]?.[1]).toEqual(browserMcpServers);
    expect(result).toBe(expected);
    expect(ClaudeBrainMock).not.toHaveBeenCalled();
  });
});
