import { describe, expect, test, vi } from "vitest";

const { queryMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: queryMock,
}));

import { ClaudeBrain } from "../../src/brain/claude-brain.js";

describe("ClaudeBrain", () => {
  test("emits normalized tool lifecycle events while streaming", async () => {
    queryMock.mockReturnValue((async function* () {
      yield {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "tool-1",
              name: "mcp__concurrent-browser__browser_create_instance",
              input: {
                headless: false,
                viewport: { width: 1440, height: 900 },
              },
            },
          ],
        },
        parent_tool_use_id: null,
        uuid: "assistant-1",
        session_id: "session-1",
      };
      yield {
        type: "tool_progress",
        tool_name: "mcp__concurrent-browser__browser_create_instance",
        tool_use_id: "tool-1",
        parent_tool_use_id: null,
        elapsed_time_seconds: 1,
        uuid: "progress-1",
        session_id: "session-1",
      };
      yield {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              is_error: false,
              content: [
                {
                  type: "text",
                  text: "browser attached",
                },
              ],
            },
          ],
        },
        parent_tool_use_id: "tool-1",
        tool_use_result: {
          content: [
            {
              type: "text",
              text: "browser attached",
            },
          ],
          instanceId: "browser-1",
        },
        uuid: "user-1",
        session_id: "session-1",
      };
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "browser ok",
        total_cost_usd: 0,
        duration_ms: 42,
        duration_api_ms: 21,
        num_turns: 1,
        usage: {
          input_tokens: 12,
          output_tokens: 6,
        },
        modelUsage: {},
        permission_denials: [],
        stop_reason: null,
        uuid: "result-1",
        session_id: "session-1",
      };
    })());

    const brain = new ClaudeBrain({
      provider: "claude",
      env: {},
      config: {},
    });
    const thread = brain.startThread({
      workingDirectory: "/tmp",
      sandboxMode: "workspace-write",
    });
    const events: unknown[] = [];

    const result = await thread.run("browser check", {
      onStreamEvent: (event) => events.push(event),
    });

    expect(result.finalResponse).toBe("browser ok");
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool_started",
          provider: "claude",
          toolName: "mcp__concurrent-browser__browser_create_instance",
          toolUseId: "tool-1",
          argumentsSummary: expect.objectContaining({
            headless: false,
          }),
        }),
        expect.objectContaining({
          type: "tool_progress",
          provider: "claude",
          toolName: "mcp__concurrent-browser__browser_create_instance",
          toolUseId: "tool-1",
          elapsedSeconds: 1,
        }),
        expect.objectContaining({
          type: "tool_completed",
          provider: "claude",
          toolName: "mcp__concurrent-browser__browser_create_instance",
          toolUseId: "tool-1",
          resultSummary: expect.any(Array),
        }),
      ]),
    );
  });
});
