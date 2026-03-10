import type { Message, MessageType } from "../types";
import { coalesceMessages } from "./useCoalescedMessages";
import { TestResult } from "../test/hookTestUtils";

function makeMessage(id: string, type: MessageType, llmData?: unknown): Message {
  return {
    message_id: id,
    conversation_id: "conv-1",
    sequence_id: Number(id.replace(/\D/g, "")) || 1,
    type,
    llm_data: llmData ? JSON.stringify(llmData) : null,
    user_data: null,
    usage_data: null,
    created_at: new Date().toISOString(),
    display_data: null,
    end_of_turn: true,
  };
}

export function runTests(): TestResult {
  const results: TestResult = { passed: 0, failed: 0, failures: [] };
  const tests: Array<{ name: string; fn: () => void }> = [];

  const assert = (condition: boolean, message: string) => {
    if (!condition) throw new Error(`Assertion failed: ${message}`);
  };

  function test(name: string, fn: () => void) {
    tests.push({ name, fn });
  }

  test("coalesces tool use and tool result into a single tool item", () => {
    const toolUse = makeMessage("m1", "agent", {
      Content: [{ ID: "tool-1", Type: 5, ToolName: "exec", ToolInput: { cmd: "pwd" } }],
    });
    const toolResult = makeMessage("m2", "user", {
      Content: [
        {
          ID: "result-1",
          Type: 6,
          ToolUseID: "tool-1",
          ToolResult: [{ ID: "text-1", Type: 2, Text: "/repo" }],
          ToolUseStartTime: "2025-01-01T00:00:00Z",
          ToolUseEndTime: "2025-01-01T00:00:01Z",
        },
      ],
    });

    const items = coalesceMessages([toolUse, toolResult]);
    assert(items.length === 1, "should produce one tool item");
    assert(items[0].type === "tool", "should be a tool item");
    assert(items[0].toolName === "exec", "should preserve tool name");
    assert(items[0].hasResult === true, "should mark tool as completed");
    assert(items[0].toolResult?.[0].Text === "/repo", "should attach tool result");
  });

  test("preserves renderable assistant text while stripping tool_use blocks", () => {
    const message = makeMessage("m1", "agent", {
      Content: [
        { ID: "text-1", Type: 2, Text: "hello" },
        { ID: "tool-1", Type: 5, ToolName: "exec", ToolInput: { cmd: "pwd" } },
      ],
    });

    const items = coalesceMessages([message]);
    assert(items.length === 2, "should emit message and tool items");
    assert(items[0].type === "message", "first item should be message");
    assert(
      typeof items[0].message?.llm_data === "string" &&
        items[0].message?.llm_data.includes("hello") &&
        !items[0].message?.llm_data.includes("ToolName"),
      "renderable message should keep text content only",
    );
  });

  test("drops non-distill system messages", () => {
    const message = makeMessage("m1", "system", { Content: [] });
    const items = coalesceMessages([message]);
    assert(items.length === 0, "should skip plain system messages");
  });

  for (const { name, fn } of tests) {
    try {
      fn();
      results.passed += 1;
    } catch (err) {
      results.failed += 1;
      results.failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return results;
}
