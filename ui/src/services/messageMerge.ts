import { Message } from "../types";

export function mergeMessagesPreserveOrder(base: Message[], incoming: Message[]): Message[] {
  if (base.length === 0) {
    return incoming.slice();
  }
  if (incoming.length === 0) {
    return base.slice();
  }

  const byId = new Map<string, Message>();
  for (const message of base) {
    byId.set(message.message_id, message);
  }
  for (const message of incoming) {
    byId.set(message.message_id, message);
  }

  const result: Message[] = [];
  const seen = new Set<string>();

  for (const message of base) {
    const merged = byId.get(message.message_id);
    if (merged) {
      result.push(merged);
      seen.add(message.message_id);
    }
  }

  for (const message of incoming) {
    if (seen.has(message.message_id)) {
      continue;
    }
    result.push(message);
    seen.add(message.message_id);
  }

  return result;
}

