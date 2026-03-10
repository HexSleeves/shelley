import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api } from "../services/api";
import { conversationCache } from "../services/conversationCache";
import { mergeMessagesPreserveOrder } from "../services/messageMerge";
import { createConversationMessageCountStore } from "../services/conversationViewState";
import { Conversation, Message } from "../types";

export interface LoadingProgress {
  phase: "downloading" | "parsing";
  bytesDownloaded: number;
  bytesTotal?: number;
}

interface UseConversationSnapshotArgs {
  conversationId: string | null;
  onConversationUpdate?: (conversation: Conversation) => void;
  onSelectedModelChange?: (model: string) => void;
}

interface UseConversationSnapshotResult {
  messages: Message[];
  loading: boolean;
  showLoadingProgressUI: boolean;
  loadingProgress: LoadingProgress | null;
  lastKnownMessageCount: number | null;
  agentWorking: boolean;
  contextWindowSize: number;
  currentMessagesRef: MutableRefObject<Message[]>;
  lastEventIdRef: MutableRefObject<number>;
  setAgentWorking: (working: boolean) => void;
  setContextWindowSize: (size: number) => void;
  setMessages: Dispatch<SetStateAction<Message[]>>;
  setLoading: Dispatch<SetStateAction<boolean>>;
  setLastKnownMessageCount: Dispatch<SetStateAction<number | null>>;
  loadMessages: () => Promise<void>;
  resetSnapshot: () => void;
  persistLastEventId: () => void;
  applyIncomingMessages: (incomingMessages: Message[]) => void;
  applyConversationUpdate: (conversation: Conversation) => void;
  applyContextWindowSize: (size: number) => void;
}

export function useConversationSnapshot({
  conversationId,
  onConversationUpdate,
  onSelectedModelChange,
}: UseConversationSnapshotArgs): UseConversationSnapshotResult {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [showLoadingProgressUI, setShowLoadingProgressUI] = useState(false);
  const [loadingProgress, setLoadingProgress] = useState<LoadingProgress | null>(null);
  const [lastKnownMessageCount, setLastKnownMessageCount] = useState<number | null>(null);
  const [agentWorking, setAgentWorking] = useState(false);
  const [contextWindowSize, setContextWindowSize] = useState(0);
  const currentMessagesRef = useRef<Message[]>([]);
  const lastEventIdRef = useRef(0);
  const loadingProgressDelayRef = useRef<number | null>(null);
  const onConversationUpdateRef = useRef(onConversationUpdate);
  const onSelectedModelChangeRef = useRef(onSelectedModelChange);

  const messageCountStore = useMemo(
    () => createConversationMessageCountStore(conversationId),
    [conversationId],
  );

  useEffect(() => {
    onConversationUpdateRef.current = onConversationUpdate;
  }, [onConversationUpdate]);

  useEffect(() => {
    onSelectedModelChangeRef.current = onSelectedModelChange;
  }, [onSelectedModelChange]);

  const clearLoadingProgress = useCallback(() => {
    if (loadingProgressDelayRef.current) {
      clearTimeout(loadingProgressDelayRef.current);
      loadingProgressDelayRef.current = null;
    }
    setShowLoadingProgressUI(false);
    setLoadingProgress(null);
  }, []);

  const loadMessages = useCallback(async () => {
    if (!conversationId) return;

    const cached = conversationCache.get(conversationId);
    if (cached) {
      currentMessagesRef.current = cached.messages;
      setMessages(cached.messages);
      setLastKnownMessageCount(cached.messages.length);
      messageCountStore.save(cached.messages.length);
      setContextWindowSize(cached.contextWindowSize);
      lastEventIdRef.current = cached.lastEventId;
      setLoading(false);
      clearLoadingProgress();
      onConversationUpdateRef.current?.(cached.conversation);
      return;
    }

    try {
      setLoading(true);
      setShowLoadingProgressUI(false);
      if (loadingProgressDelayRef.current) {
        clearTimeout(loadingProgressDelayRef.current);
      }
      loadingProgressDelayRef.current = window.setTimeout(() => {
        setShowLoadingProgressUI(true);
      }, 500);
      setLastKnownMessageCount(messageCountStore.load());
      setLoadingProgress({ phase: "downloading", bytesDownloaded: 0 });

      const response = await api.getConversationWithProgress(conversationId, (progress) => {
        setLoadingProgress(progress);
      });
      const loadedMessages = response.messages ?? [];
      const mergedMessages = mergeMessagesPreserveOrder(loadedMessages, currentMessagesRef.current);
      currentMessagesRef.current = mergedMessages;
      setMessages(mergedMessages);
      setLastKnownMessageCount(mergedMessages.length);
      messageCountStore.save(mergedMessages.length);
      setLoading(false);
      clearLoadingProgress();
      setContextWindowSize(response.context_window_size ?? 0);
      if (response.runtime) {
        setAgentWorking(response.runtime.working);
        if (response.runtime.current_model_id) {
          onSelectedModelChangeRef.current?.(response.runtime.current_model_id);
        }
      }
      onConversationUpdateRef.current?.(response.conversation);
      lastEventIdRef.current = response.last_event_id ?? 0;
      conversationCache.set(
        conversationId,
        { ...response, messages: mergedMessages },
        lastEventIdRef.current,
      );
    } catch (err) {
      console.error("Failed to load messages:", err);
      setLoading(false);
      clearLoadingProgress();
      throw err;
    }
  }, [
    clearLoadingProgress,
    conversationId,
    messageCountStore,
  ]);

  const resetSnapshot = useCallback(() => {
    currentMessagesRef.current = [];
    setMessages([]);
    setContextWindowSize(0);
    setLastKnownMessageCount(null);
    setAgentWorking(false);
    setLoading(false);
    clearLoadingProgress();
  }, [clearLoadingProgress]);

  const persistLastEventId = useCallback(() => {
    if (!conversationId || lastEventIdRef.current < 0) return;
    const cached = conversationCache.peek(conversationId);
    if (cached) {
      cached.lastEventId = lastEventIdRef.current;
    }
  }, [conversationId]);

  const applyIncomingMessages = useCallback(
    (incomingMessages: Message[]) => {
      if (!conversationId || incomingMessages.length === 0) return;
      setMessages((prev) => {
        const mergedMessages = mergeMessagesPreserveOrder(prev, incomingMessages);
        currentMessagesRef.current = mergedMessages;
        setLastKnownMessageCount(mergedMessages.length);
        messageCountStore.save(mergedMessages.length);
        return mergedMessages;
      });
      conversationCache.updateMessages(conversationId, incomingMessages);
    },
    [conversationId, messageCountStore],
  );

  const applyConversationUpdate = useCallback(
    (conversation: Conversation) => {
      onConversationUpdateRef.current?.(conversation);
      if (conversationId) {
        conversationCache.updateConversation(conversationId, conversation);
      }
    },
    [conversationId],
  );

  const applyContextWindowSize = useCallback(
    (size: number) => {
      setContextWindowSize(size);
      if (conversationId) {
        conversationCache.updateContextWindowSize(conversationId, size);
      }
    },
    [conversationId],
  );

  useEffect(() => {
    currentMessagesRef.current = messages;
  }, [messages]);

  useEffect(() => () => clearLoadingProgress(), [clearLoadingProgress]);

  return {
    messages,
    loading,
    showLoadingProgressUI,
    loadingProgress,
    lastKnownMessageCount,
    agentWorking,
    contextWindowSize,
    currentMessagesRef,
    lastEventIdRef,
    setAgentWorking,
    setContextWindowSize,
    setMessages,
    setLoading,
    setLastKnownMessageCount,
    loadMessages,
    resetSnapshot,
    persistLastEventId,
    applyIncomingMessages,
    applyConversationUpdate,
    applyContextWindowSize,
  };
}
