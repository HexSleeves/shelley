import { conversationCache } from "../services/conversationCache";
import { api } from "../services/api";
import { useConversationStream } from "./useConversationStream";
import { makeConversation, makeTextMessage, MockEventSource } from "../test/hookFixtures";
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

  const originalCreateMessageStream = api.createMessageStream.bind(api);

  test("applies stream payloads to the hook state and callbacks", async () => {
    const conversation = makeConversation("conv-stream");
    const message = makeTextMessage("m1", "conv-stream", "agent", "hello");
    const lastEventIdRef = { current: 0 };
    const incomingMessages: string[] = [];
    const updatedConversations: string[] = [];
    const contextWindowSizes: number[] = [];
    const workingStates: boolean[] = [];
    const models: string[] = [];
    const stateUpdates: boolean[] = [];

    api.createMessageStream = (conversationId, lastEventId) =>
      new MockEventSource(
        `/api/conversation/${conversationId}/stream${lastEventId ? `?last_event_id=${lastEventId}` : ""}`,
      ) as unknown as EventSource;

    const hook = renderHook(useConversationStream, {
      conversationId: conversation.conversation_id,
      lastEventIdRef,
      setAgentWorking: (working) => {
        workingStates.push(working);
      },
      onSelectedModelChange: (model) => {
        models.push(model);
      },
      applyIncomingMessages: (messages) => {
        incomingMessages.push(...messages.map((nextMessage) => nextMessage.message_id));
      },
      applyConversationUpdate: (nextConversation) => {
        updatedConversations.push(nextConversation.conversation_id);
      },
      applyContextWindowSize: (size) => {
        contextWindowSizes.push(size);
      },
      onConversationListUpdate: undefined,
      onConversationStateUpdate: (state) => {
        stateUpdates.push(state.working);
      },
      onReconnect: undefined,
    });

    const source = MockEventSource.instances[0];
    await runWithAct(() => {
      source.emitOpen();
    });
    await runWithAct(() => {
      source.emitMessage({
        version: 1,
        event_id: 12,
        conversation_id: conversation.conversation_id,
        type: "message",
        created_at: "2026-03-10T12:00:00.000Z",
        payload: {
          messages: [message],
          conversation,
          context_window_size: 48,
          conversation_state: {
            conversation_id: conversation.conversation_id,
            working: true,
            model: "model-b",
          },
          streaming_text: "hello",
          streaming_thinking: "thinking",
        },
      });
    });

    assert(lastEventIdRef.current === 12, "should advance the resume cursor");
    assert(incomingMessages.join(",") === message.message_id, "should forward streamed messages");
    assert(updatedConversations.join(",") === conversation.conversation_id, "should forward conversation updates");
    assert(contextWindowSizes.join(",") === "48", "should forward context window updates");
    assert(workingStates.join(",") === "true", "should update working state from stream state updates");
    assert(models.join(",") === "model-b", "should update the selected model from stream state updates");
    assert(stateUpdates.join(",") === "true", "should publish conversation state updates");
    assert(hook.getResult().streamingText === "hello", "should accumulate streaming text");
    assert(hook.getResult().streamingThinking === "thinking", "should accumulate streaming thinking");
    assert(
      conversationCache.peek(conversation.conversation_id)?.lastEventId === 12 ||
        conversationCache.peek(conversation.conversation_id) === undefined,
      "should never regress the cached last event id",
    );
    hook.unmount();
  });

  test("marks the stream disconnected after repeated errors and can reconnect", async () => {
    const lastEventIdRef = { current: 3 };
    let reconnects = 0;

    api.createMessageStream = () => new MockEventSource("/stream") as unknown as EventSource;

    const hook = renderHook(useConversationStream, {
      conversationId: "conv-reconnect",
      lastEventIdRef,
      setAgentWorking: () => {},
      onSelectedModelChange: undefined,
      applyIncomingMessages: () => {},
      applyConversationUpdate: () => {},
      applyContextWindowSize: () => {},
      onConversationListUpdate: undefined,
      onConversationStateUpdate: undefined,
      onReconnect: () => {
        reconnects += 1;
      },
    });

    const firstSource = MockEventSource.instances[0];
    await runWithAct(() => {
      firstSource.emitOpen();
    });
    await runWithAct(() => {
      firstSource.emitError();
      firstSource.emitError();
      firstSource.emitError();
      firstSource.emitError();
    });

    assert(hook.getResult().isDisconnected === true, "should mark the stream disconnected after retries are exhausted");
    assert(hook.getResult().isReconnecting === false, "should stop the reconnecting state after retries are exhausted");
    assert(hook.getResult().reconnectAttempts === 4, "should count failed reconnect attempts");

    await runWithAct(() => hook.getResult().reconnect());
    assert(MockEventSource.instances.length === 2, "should open a fresh EventSource on manual reconnect");
    await runWithAct(() => {
      MockEventSource.instances[1].emitOpen();
    });
    assert(reconnects === 1, "should call onReconnect after a successful reconnect");
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
      api.createMessageStream = originalCreateMessageStream;
      conversationCache.clear();
      MockEventSource.reset();
    }
  }

  return results;
}
