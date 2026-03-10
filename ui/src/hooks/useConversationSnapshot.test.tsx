import { conversationCache } from "../services/conversationCache";
import { api } from "../services/api";
import { useConversationSnapshot } from "./useConversationSnapshot";
import { makeConversation, makeRuntime, makeTextMessage } from "../test/hookFixtures";
import { assert, renderHook, runWithAct, TestResult } from "../test/hookTestUtils";

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

  test("loadMessages prefers cached conversation data", async () => {
    const conversation = makeConversation("conv-cache");
    const cachedMessage = makeTextMessage("m1", "conv-cache", "agent", "cached");
    let updatedConversation = "";
    let selectedModel = "";
    let fetchCalls = 0;

    conversationCache.set(
      conversation.conversation_id,
      {
        conversation,
        messages: [cachedMessage],
        context_window_size: 42,
      },
      7,
    );
    api.getConversationWithProgress = async () => {
      fetchCalls += 1;
      throw new Error("unexpected fetch");
    };

    const hook = renderHook(useConversationSnapshot, {
      conversationId: conversation.conversation_id,
      onConversationUpdate: (nextConversation) => {
        updatedConversation = nextConversation.conversation_id;
      },
      onSelectedModelChange: (model) => {
        selectedModel = model;
      },
    });

    await runWithAct(() => hook.getResult().loadMessages());

    assert(fetchCalls === 0, "should not fetch when cache is populated");
    assert(hook.getResult().messages.length === 1, "should load cached messages");
    assert(hook.getResult().messages[0].message_id === cachedMessage.message_id, "should use cached message order");
    assert(hook.getResult().contextWindowSize === 42, "should load cached context window size");
    assert(hook.getResult().lastKnownMessageCount === 1, "should record cached message count");
    assert(hook.getResult().lastEventIdRef.current === 7, "should restore cached last event id");
    assert(updatedConversation === conversation.conversation_id, "should publish cached conversation metadata");
    assert(selectedModel === "", "should not change model from cache-only load");
    hook.unmount();
  });

  test("loadMessages fetches snapshot data and persists resume metadata", async () => {
    const conversation = makeConversation("conv-fetch");
    const fetchedMessage = makeTextMessage("m2", "conv-fetch", "agent", "fetched");
    const progressPhases: string[] = [];
    let updatedConversation = "";
    let selectedModel = "";

    api.getConversationWithProgress = async (_conversationId, onProgress) => {
      onProgress?.({ phase: "downloading", bytesDownloaded: 12, bytesTotal: 20 });
      progressPhases.push("downloading");
      onProgress?.({ phase: "parsing", bytesDownloaded: 20, bytesTotal: 20 });
      progressPhases.push("parsing");
      return {
        conversation,
        messages: [fetchedMessage],
        context_window_size: 64,
        last_event_id: 11,
        runtime: makeRuntime(conversation.conversation_id, {
          working: true,
          last_event_id: 11,
          current_model_id: "model-z",
        }),
      };
    };

    const hook = renderHook(useConversationSnapshot, {
      conversationId: conversation.conversation_id,
      onConversationUpdate: (nextConversation) => {
        updatedConversation = nextConversation.conversation_id;
      },
      onSelectedModelChange: (model) => {
        selectedModel = model;
      },
    });

    await runWithAct(() => hook.getResult().loadMessages());

    assert(progressPhases.join(",") === "downloading,parsing", "should surface download and parse progress");
    assert(hook.getResult().messages.length === 1, "should load fetched messages");
    assert(hook.getResult().agentWorking === true, "should hydrate runtime working state");
    assert(hook.getResult().contextWindowSize === 64, "should store fetched context window size");
    assert(hook.getResult().lastEventIdRef.current === 11, "should record fetched last event id");
    assert(updatedConversation === conversation.conversation_id, "should publish fetched conversation metadata");
    assert(selectedModel === "model-z", "should publish runtime model selection");

    hook.getResult().lastEventIdRef.current = 19;
    hook.getResult().persistLastEventId();
    assert(
      conversationCache.peek(conversation.conversation_id)?.lastEventId === 19,
      "should persist updated last event ids back to cache",
    );
    hook.unmount();
  });

  test("applyIncomingMessages merges into state and cache", async () => {
    const conversation = makeConversation("conv-merge");
    const originalMessage = makeTextMessage("m1", "conv-merge", "agent", "first");
    const newMessage = makeTextMessage("m2", "conv-merge", "agent", "second");

    conversationCache.set(
      conversation.conversation_id,
      {
        conversation,
        messages: [originalMessage],
        context_window_size: 0,
      },
      0,
    );

    const hook = renderHook(useConversationSnapshot, {
      conversationId: conversation.conversation_id,
      onConversationUpdate: undefined,
      onSelectedModelChange: undefined,
    });

    await runWithAct(() => hook.getResult().loadMessages());
    await runWithAct(() => hook.getResult().applyIncomingMessages([newMessage]));

    assert(hook.getResult().messages.length === 2, "should merge new stream messages into snapshot state");
    assert(
      conversationCache.peek(conversation.conversation_id)?.messages.length === 2,
      "should merge new stream messages into cache",
    );
    hook.unmount();
  });

  for (const { name, fn } of tests) {
    try {
      conversationCache.clear();
      await fn();
      results.passed += 1;
    } catch (err) {
      results.failed += 1;
      results.failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      api.getConversationWithProgress = originalGetConversationWithProgress;
      conversationCache.clear();
    }
  }

  return results;
}
