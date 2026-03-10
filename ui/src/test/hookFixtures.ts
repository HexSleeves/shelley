import { Conversation, ConversationRuntime, Message } from "../types";

const now = "2026-03-10T12:00:00.000Z";

export function makeConversation(
  conversationId: string,
  overrides: Partial<Conversation> = {},
): Conversation {
  return {
    conversation_id: conversationId,
    slug: `slug-${conversationId}`,
    user_initiated: true,
    created_at: now,
    updated_at: now,
    cwd: "/repo",
    archived: false,
    parent_conversation_id: null,
    model: "model-a",
    ...overrides,
  };
}

export function makeRuntime(
  conversationId: string,
  overrides: Partial<ConversationRuntime> = {},
): ConversationRuntime {
  return {
    conversation_id: conversationId,
    working: false,
    active_job_id: null,
    last_event_id: 0,
    current_model_id: null,
    updated_at: now,
    ...overrides,
  };
}

export function makeTextMessage(
  id: string,
  conversationId: string,
  type: Message["type"] = "agent",
  text = `message-${id}`,
): Message {
  return {
    message_id: id,
    conversation_id: conversationId,
    sequence_id: Number(id.replace(/\D/g, "")) || 1,
    type,
    llm_data: JSON.stringify({
      Role: type === "user" ? 0 : 1,
      Content: [{ ID: `${id}-content`, Type: 2, Text: text }],
    }),
    user_data: null,
    usage_data: null,
    created_at: now,
    display_data: null,
    end_of_turn: true,
  };
}

export class MockEventSource {
  static instances: MockEventSource[] = [];

  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readyState = 0;

  constructor(public readonly url: string) {
    MockEventSource.instances.push(this);
  }

  close(): void {
    this.readyState = 2;
  }

  emitOpen(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  emitMessage(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent<string>);
  }

  emitError(): void {
    this.readyState = 2;
    this.onerror?.(new Event("error"));
  }

  static reset(): void {
    MockEventSource.instances = [];
  }
}
