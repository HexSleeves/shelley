import { api } from "../services/api";
import { useConversationActions } from "./useConversationActions";
import { assert, renderHook, setupDom, TestResult } from "../test/hookTestUtils";

interface TestCase {
  name: string;
  fn: () => Promise<void> | void;
}

export async function runTests(): Promise<TestResult> {
  const tests: TestCase[] = [];
  const results: TestResult = { passed: 0, failed: 0, failures: [] };

  function test(name: string, fn: () => Promise<void> | void) {
    tests.push({ name, fn });
  }

  const originalValidateCwd = api.validateCwd.bind(api);
  const originalSendMessage = api.sendMessage.bind(api);
  const originalCancelConversation = api.cancelConversation.bind(api);

  test("first message validates cwd and calls onFirstMessage", async () => {
    let firstMessageArgs: [string, string, string | undefined] | null = null;
    api.validateCwd = async () => ({ valid: true });

    const hook = renderHook(useConversationActions, {
      conversationId: null,
      selectedModel: "model-a",
      selectedCwd: "/repo",
      onFirstMessage: async (message, model, cwd) => {
        firstMessageArgs = [message, model, cwd];
      },
      setAgentWorking: () => {},
      setError: () => {},
    });

    await hook.getResult().sendConversationMessage("hello");
    assert(firstMessageArgs !== null, "should invoke onFirstMessage");
    assert(firstMessageArgs?.[0] === "hello", "should pass trimmed message");
    assert(firstMessageArgs?.[1] === "model-a", "should pass selected model");
    assert(firstMessageArgs?.[2] === "/repo", "should pass cwd");
    hook.unmount();
  });

  test("existing conversation sends through api", async () => {
    let sentArgs: [string, { message: string; model?: string }] | null = null;
    api.sendMessage = async (conversationId, request) => {
      sentArgs = [conversationId, request];
    };

    const hook = renderHook(useConversationActions, {
      conversationId: "conv-1",
      selectedModel: "model-a",
      selectedCwd: "",
      onFirstMessage: undefined,
      setAgentWorking: () => {},
      setError: () => {},
    });

    await hook.getResult().sendConversationMessage("hello");
    assert(sentArgs !== null, "should call api.sendMessage");
    if (sentArgs === null) {
      throw new Error("sendMessage args missing");
    }
    assert(sentArgs[0] === "conv-1", "should use conversation id");
    const request = sentArgs[1] as { message: string; model?: string };
    assert(request.model === "model-a", "should pass selected model");
    hook.unmount();
  });

  test("cancelConversation calls api.cancelConversation", async () => {
    let cancelledConversationId: string | null = null;
    api.cancelConversation = async (conversationId) => {
      cancelledConversationId = conversationId;
    };

    const hook = renderHook(useConversationActions, {
      conversationId: "conv-2",
      selectedModel: "model-a",
      selectedCwd: "",
      onFirstMessage: undefined,
      setAgentWorking: () => {},
      setError: () => {},
    });

    await hook.getResult().cancelConversation();
    assert(cancelledConversationId === "conv-2", "should cancel the active conversation");
    hook.unmount();
  });

  for (const { name, fn } of tests) {
    try {
      await fn();
      results.passed += 1;
    } catch (err) {
      results.failed += 1;
      results.failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      api.validateCwd = originalValidateCwd;
      api.sendMessage = originalSendMessage;
      api.cancelConversation = originalCancelConversation;
    }
  }

  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cleanup = setupDom();
  runTests()
    .then((results) => {
      console.log(`\nuseConversationActions Tests: ${results.passed} passed, ${results.failed} failed\n`);
      if (results.failures.length > 0) {
        for (const failure of results.failures) {
          console.log(failure);
        }
        process.exitCode = 1;
      }
    })
    .finally(() => cleanup());
}
