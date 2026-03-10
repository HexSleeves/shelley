import { conversationCache } from "../services/conversationCache";
import { api } from "../services/api";
import { useConversationSession } from "./useConversationSession";
import { makeConversation, makeRuntime, makeTextMessage, MockEventSource } from "../test/hookFixtures";
import { assert, flushEffects, renderHook, TestResult } from "../test/hookTestUtils";

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

  const originalGetConversationWithProgress = api.getConversationWithProgress.bind(api);
  const originalCreateMessageStream = api.createMessageStream.bind(api);

  test("loads snapshot state and resets it when the conversation closes", async () => {
    const conversation = makeConversation("conv-session");
    const message = makeTextMessage("m1", "conv-session", "agent", "session");
    let loadCalls = 0;

    api.getConversationWithProgress = async () => {
      loadCalls += 1;
      return {
        conversation,
        messages: [message],
        context_window_size: 88,
        last_event_id: 5,
        runtime: makeRuntime(conversation.conversation_id, {
          working: true,
          last_event_id: 5,
          current_model_id: "model-session",
        }),
      };
    };
    api.createMessageStream = () => new MockEventSource("/stream") as unknown as EventSource;

    const hook = renderHook(useConversationSession, {
      conversationId: conversation.conversation_id as string | null,
      selectedModel: "model-session",
      selectedCwd: "/repo",
      onConversationUpdate: undefined,
      onConversationListUpdate: undefined,
      onConversationStateUpdate: undefined,
      onFirstMessage: undefined,
      onReconnect: undefined,
      onSelectedModelChange: undefined,
    });

    await flushEffects();
    await flushEffects();

    assert(loadCalls === 1, "should fetch the active conversation snapshot");
    assert(hook.getResult().messages.length === 1, "should expose loaded messages");
    assert(hook.getResult().contextWindowSize === 88, "should expose the loaded context window size");
    assert(hook.getResult().agentWorking === true, "should expose the loaded runtime state");

    await hook.rerender({
      conversationId: null,
      selectedModel: "model-session",
      selectedCwd: "/repo",
      onConversationUpdate: undefined,
      onConversationListUpdate: undefined,
      onConversationStateUpdate: undefined,
      onFirstMessage: undefined,
      onReconnect: undefined,
      onSelectedModelChange: undefined,
    });
    await flushEffects();

    assert(hook.getResult().messages.length === 0, "should clear messages when there is no active conversation");
    assert(hook.getResult().agentWorking === false, "should clear working state when there is no active conversation");
    assert(hook.getResult().error === null, "should clear stale errors when there is no active conversation");
    hook.unmount();
  });

  test("surfaces snapshot load failures as session errors", async () => {
    api.getConversationWithProgress = async () => {
      throw new Error("boom");
    };
    api.createMessageStream = () => new MockEventSource("/stream") as unknown as EventSource;

    const hook = renderHook(useConversationSession, {
      conversationId: "conv-error",
      selectedModel: "model-a",
      selectedCwd: "/repo",
      onConversationUpdate: undefined,
      onConversationListUpdate: undefined,
      onConversationStateUpdate: undefined,
      onFirstMessage: undefined,
      onReconnect: undefined,
      onSelectedModelChange: undefined,
    });

    await flushEffects();
    await flushEffects();

    assert(hook.getResult().error === "Failed to load messages", "should expose load failures as user-facing session errors");
    hook.unmount();
  });

  for (const { name, fn } of tests) {
    try {
      conversationCache.clear();
      MockEventSource.reset();
      await fn();
      results.passed += 1;
    } catch (err) {
      results.failed += 1;
      results.failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      api.getConversationWithProgress = originalGetConversationWithProgress;
      api.createMessageStream = originalCreateMessageStream;
      conversationCache.clear();
      MockEventSource.reset();
    }
  }

  return results;
}
