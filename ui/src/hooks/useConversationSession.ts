import { type Dispatch, type SetStateAction, useEffect, useState } from "react";
import { setFaviconStatus } from "../services/favicon";
import { Conversation, ConversationListUpdate, ConversationState, Message } from "../types";
import { useConversationActions } from "./useConversationActions";
import { useConversationSnapshot, type LoadingProgress } from "./useConversationSnapshot";
import { useConversationStream } from "./useConversationStream";

interface UseConversationSessionArgs {
  conversationId: string | null;
  selectedModel: string;
  selectedCwd: string;
  onConversationUpdate?: (conversation: Conversation) => void;
  onConversationListUpdate?: (update: ConversationListUpdate) => void;
  onConversationStateUpdate?: (state: ConversationState) => void;
  onFirstMessage?: (message: string, model: string, cwd?: string) => Promise<void>;
  onReconnect?: () => void;
  onSelectedModelChange?: (model: string) => void;
}

interface UseConversationSessionResult {
  messages: Message[];
  loading: boolean;
  showLoadingProgressUI: boolean;
  loadingProgress: LoadingProgress | null;
  lastKnownMessageCount: number | null;
  sending: boolean;
  cancelling: boolean;
  error: string | null;
  setError: Dispatch<SetStateAction<string | null>>;
  agentWorking: boolean;
  contextWindowSize: number;
  reconnectAttempts: number;
  isDisconnected: boolean;
  isReconnecting: boolean;
  pauseAutoScroll: boolean;
  streamingText: string;
  streamingThinking: string;
  sendConversationMessage: (message: string) => Promise<void>;
  cancelConversation: () => Promise<void>;
  reconnect: () => void;
}

export function useConversationSession({
  conversationId,
  selectedModel,
  selectedCwd,
  onConversationUpdate,
  onConversationListUpdate,
  onConversationStateUpdate,
  onFirstMessage,
  onReconnect,
  onSelectedModelChange,
}: UseConversationSessionArgs): UseConversationSessionResult {
  const [error, setError] = useState<string | null>(null);
  const {
    messages,
    loading,
    showLoadingProgressUI,
    loadingProgress,
    lastKnownMessageCount,
    agentWorking,
    contextWindowSize,
    lastEventIdRef,
    setAgentWorking,
    loadMessages,
    resetSnapshot,
    persistLastEventId,
    applyIncomingMessages,
    applyConversationUpdate,
    applyContextWindowSize,
  } = useConversationSnapshot({
    conversationId,
    onConversationUpdate,
    onSelectedModelChange,
  });
  const {
    reconnectAttempts,
    isDisconnected,
    isReconnecting,
    pauseAutoScroll,
    streamingText,
    streamingThinking,
    reconnect,
    resetStreamState,
  } = useConversationStream({
    conversationId,
    lastEventIdRef,
    setAgentWorking,
    onSelectedModelChange,
    applyIncomingMessages,
    applyConversationUpdate,
    applyContextWindowSize,
    onConversationListUpdate,
    onConversationStateUpdate,
    onReconnect,
  });
  const { sending, cancelling, sendConversationMessage, cancelConversation } =
    useConversationActions({
    conversationId,
    selectedModel,
    selectedCwd,
    onFirstMessage,
    setAgentWorking,
    setError,
  });

  useEffect(() => {
    if (conversationId) {
      setError(null);
      loadMessages().catch(() => {
        setError("Failed to load messages");
      });
    } else {
      resetSnapshot();
      resetStreamState();
      setError(null);
    }

    return () => {
      persistLastEventId();
    };
  }, [conversationId, loadMessages, persistLastEventId, resetSnapshot, resetStreamState]);

  useEffect(() => {
    if (agentWorking) {
      setFaviconStatus("working");
    }
  }, [agentWorking]);

  return {
    messages,
    loading,
    showLoadingProgressUI,
    loadingProgress,
    lastKnownMessageCount,
    sending,
    cancelling,
    error,
    setError,
    agentWorking,
    contextWindowSize,
    reconnectAttempts,
    isDisconnected,
    isReconnecting,
    pauseAutoScroll,
    streamingText,
    streamingThinking,
    sendConversationMessage,
    cancelConversation,
    reconnect,
  };
}
