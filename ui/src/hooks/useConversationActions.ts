import { useCallback, useState } from "react";
import { api } from "../services/api";

interface UseConversationActionsArgs {
  conversationId: string | null;
  selectedModel: string;
  selectedCwd: string;
  onFirstMessage?: (message: string, model: string, cwd?: string) => Promise<void>;
  setAgentWorking: (working: boolean) => void;
  setError: (error: string | null) => void;
}

interface UseConversationActionsResult {
  sending: boolean;
  cancelling: boolean;
  sendConversationMessage: (message: string) => Promise<void>;
  cancelConversation: () => Promise<void>;
}

export function useConversationActions({
  conversationId,
  selectedModel,
  selectedCwd,
  onFirstMessage,
  setAgentWorking,
  setError,
}: UseConversationActionsArgs): UseConversationActionsResult {
  const [sending, setSending] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const sendConversationMessage = useCallback(
    async (message: string) => {
      if (!message.trim() || sending) return;

      try {
        setSending(true);
        setError(null);
        setAgentWorking(true);

        if (!conversationId && onFirstMessage) {
          if (selectedCwd) {
            const validation = await api.validateCwd(selectedCwd);
            if (!validation.valid) {
              throw new Error(`Invalid working directory: ${validation.error}`);
            }
          }
          await onFirstMessage(message.trim(), selectedModel, selectedCwd || undefined);
          return;
        }

        if (conversationId) {
          await api.sendMessage(conversationId, {
            message: message.trim(),
            model: selectedModel,
          });
        }
      } catch (err) {
        console.error("Failed to send message:", err);
        setError(err instanceof Error ? err.message : "Unknown error");
        setAgentWorking(false);
        throw err;
      } finally {
        setSending(false);
      }
    },
    [conversationId, onFirstMessage, selectedCwd, selectedModel, sending, setAgentWorking, setError],
  );

  const cancelConversation = useCallback(async () => {
    if (!conversationId || cancelling) return;

    try {
      setCancelling(true);
      await api.cancelConversation(conversationId);
      setAgentWorking(false);
    } catch (err) {
      console.error("Failed to cancel conversation:", err);
      setError("Failed to cancel. Please try again.");
    } finally {
      setCancelling(false);
    }
  }, [cancelling, conversationId, setAgentWorking, setError]);

  return {
    sending,
    cancelling,
    sendConversationMessage,
    cancelConversation,
  };
}
