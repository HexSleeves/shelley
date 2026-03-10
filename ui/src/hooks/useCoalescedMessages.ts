import { useMemo } from "react";
import { LLMContent, Message, isDistillStatusMessage } from "../types";

export interface CoalescedItem {
  type: "message" | "tool";
  message?: Message;
  toolUseId?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: LLMContent[];
  toolError?: boolean;
  toolStartTime?: string | null;
  toolEndTime?: string | null;
  hasResult?: boolean;
  display?: unknown;
}

export function coalesceMessages(messages: Message[]): CoalescedItem[] {
  if (messages.length === 0) {
    return [];
  }

  const items: CoalescedItem[] = [];
  const toolResultMap: Record<
    string,
    {
      result: LLMContent[];
      error: boolean;
      startTime: string | null;
      endTime: string | null;
    }
  > = {};
  const displayDataMap: Record<string, unknown> = {};

  messages.forEach((message) => {
    if (!message.llm_data) return;
    try {
      const llmData =
        typeof message.llm_data === "string" ? JSON.parse(message.llm_data) : message.llm_data;
      if (!llmData || !llmData.Content || !Array.isArray(llmData.Content)) {
        return;
      }
      llmData.Content.forEach((content: LLMContent) => {
        if (content && content.Type === 6 && content.ToolUseID) {
          toolResultMap[content.ToolUseID] = {
            result: content.ToolResult || [],
            error: content.ToolError || false,
            startTime: content.ToolUseStartTime || null,
            endTime: content.ToolUseEndTime || null,
          };
          if (content.Display) {
            displayDataMap[content.ToolUseID] = content.Display;
          }
        }
      });
    } catch (err) {
      console.error("Failed to parse message LLM data for tool results:", err);
    }
  });

  messages.forEach((message) => {
    if (message.type === "system") {
      if (!isDistillStatusMessage(message)) {
        return;
      }
      items.push({ type: "message", message });
      return;
    }

    if (message.type === "error") {
      items.push({ type: "message", message });
      return;
    }

    let hasToolResult = false;
    if (message.llm_data) {
      try {
        const llmData =
          typeof message.llm_data === "string" ? JSON.parse(message.llm_data) : message.llm_data;
        if (llmData && llmData.Content && Array.isArray(llmData.Content)) {
          hasToolResult = llmData.Content.some((content: LLMContent) => content.Type === 6);
        }
      } catch (err) {
        console.error("Failed to parse message LLM data:", err);
      }
    }

    if (message.type === "user" && !hasToolResult) {
      items.push({ type: "message", message });
      return;
    }

    if (message.type === "user" && hasToolResult) {
      return;
    }

    if (!message.llm_data) {
      items.push({ type: "message", message });
      return;
    }

    try {
      const llmData =
        typeof message.llm_data === "string" ? JSON.parse(message.llm_data) : message.llm_data;
      if (!llmData || !llmData.Content || !Array.isArray(llmData.Content)) {
        items.push({ type: "message", message });
        return;
      }

      const renderableContents: LLMContent[] = [];
      const toolUses: LLMContent[] = [];

      llmData.Content.forEach((content: LLMContent) => {
        if (content.Type === 2 || content.Type === 3 || content.Type === 4) {
          renderableContents.push(content);
        } else if (content.Type === 5) {
          toolUses.push(content);
        }
      });

      const hasRenderableContent = renderableContents.some((content) => {
        if (content.Type === 2) {
          return !!content.Text?.trim();
        }
        if (content.Type === 3) {
          return !!content.Thinking?.trim() || !!content.ThinkingSummary?.trim();
        }
        if (content.Type === 4) {
          return true;
        }
        return false;
      });

      if (hasRenderableContent) {
        items.push({
          type: "message",
          message: {
            ...message,
            llm_data: JSON.stringify({
              ...llmData,
              Content: renderableContents,
            }),
          },
        });
      }

      const wasTruncated = llmData.ExcludedFromContext === true;
      toolUses.forEach((toolUse) => {
        const resultData = toolUse.ID ? toolResultMap[toolUse.ID] : undefined;
        items.push({
          type: "tool",
          toolUseId: toolUse.ID,
          toolName: toolUse.ToolName,
          toolInput: toolUse.ToolInput,
          toolResult: resultData?.result,
          toolError: resultData?.error || (wasTruncated && !resultData),
          toolStartTime: resultData?.startTime,
          toolEndTime: resultData?.endTime,
          hasResult: !!resultData || wasTruncated,
          display: toolUse.ID ? displayDataMap[toolUse.ID] : undefined,
        });
      });
    } catch (err) {
      console.error("Failed to parse message LLM data:", err);
      items.push({ type: "message", message });
    }
  });

  return items;
}

export function useCoalescedMessages(messages: Message[]): CoalescedItem[] {
  return useMemo(() => coalesceMessages(messages), [messages]);
}
