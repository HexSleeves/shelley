import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api } from "../services/api";
import { conversationCache } from "../services/conversationCache";
import { setFaviconStatus } from "../services/favicon";
import { mergeMessagesPreserveOrder } from "../services/messageMerge";
import { handleNotificationEvent } from "../services/notifications";
import { createConversationMessageCountStore } from "../services/conversationViewState";
import {
  Conversation,
  ConversationListUpdate,
  ConversationState,
  Message,
  StreamEventEnvelope,
  StreamResponse,
} from "../types";

function asStreamPayload(event: StreamEventEnvelope): StreamResponse {
  if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) {
    return {} as StreamResponse;
  }
  return event.payload as StreamResponse;
}

interface LoadingProgress {
  phase: "downloading" | "parsing";
  bytesDownloaded: number;
  bytesTotal?: number;
}

interface UseConversationSessionArgs {
  conversationId: string | null;
  selectedModel: string;
  selectedCwd: string;
  onConversationUpdate?: (conversation: Conversation) => void;
  onConversationListUpdate?: (update: ConversationListUpdate) => void;
  onConversationStateUpdate?: (state: ConversationState) => void;
  onFirstMessage?: (message: string, model: string, cwd?: string) => Promise<void>;
  onReconnect?: () => void;
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
}: UseConversationSessionArgs): UseConversationSessionResult {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [showLoadingProgressUI, setShowLoadingProgressUI] = useState(false);
  const [loadingProgress, setLoadingProgress] = useState<LoadingProgress | null>(null);
  const [lastKnownMessageCount, setLastKnownMessageCount] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agentWorking, setAgentWorking] = useState(false);
  const [contextWindowSize, setContextWindowSize] = useState(0);
  const [reconnectAttempts, setReconnectAttempts] = useState(0);
  const [isDisconnected, setIsDisconnected] = useState(false);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [pauseAutoScroll, setPauseAutoScroll] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [streamingThinking, setStreamingThinking] = useState("");

  const currentMessagesRef = useRef<Message[]>([]);
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const periodicRetryRef = useRef<number | null>(null);
  const heartbeatTimeoutRef = useRef<number | null>(null);
  const lastEventIdRef = useRef(0);
  const hasConnectedRef = useRef(false);
  const hiddenAtRef = useRef<number | null>(null);
  const loadingRef = useRef(false);
  const streamingTextRef = useRef("");
  const streamingThinkingRef = useRef("");
  const streamingUpdateTimerRef = useRef<number | null>(null);
  const loadingProgressDelayRef = useRef<number | null>(null);

  const messageCountStore = useMemo(
    () => createConversationMessageCountStore(conversationId),
    [conversationId],
  );

  const clearLoadingProgress = useCallback(() => {
    if (loadingProgressDelayRef.current) {
      clearTimeout(loadingProgressDelayRef.current);
      loadingProgressDelayRef.current = null;
    }
    setShowLoadingProgressUI(false);
    setLoadingProgress(null);
  }, []);

  const stopStreamingRender = useCallback(() => {
    streamingTextRef.current = "";
    streamingThinkingRef.current = "";
    if (streamingUpdateTimerRef.current) {
      cancelAnimationFrame(streamingUpdateTimerRef.current);
      streamingUpdateTimerRef.current = null;
    }
    setStreamingText("");
    setStreamingThinking("");
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
      loadingRef.current = false;
      setLoading(false);
      clearLoadingProgress();
      onConversationUpdate?.(cached.conversation);
      return;
    }

    try {
      loadingRef.current = true;
      setLoading(true);
      setError(null);
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
      loadingRef.current = false;
      setLoading(false);
      clearLoadingProgress();
      setContextWindowSize(response.context_window_size ?? 0);
      if (response.runtime) {
        setAgentWorking(response.runtime.working);
      }
      onConversationUpdate?.(response.conversation);
      lastEventIdRef.current = response.last_event_id ?? 0;
      conversationCache.set(
        conversationId,
        { ...response, messages: mergedMessages },
        lastEventIdRef.current,
      );
    } catch (err) {
      console.error("Failed to load messages:", err);
      setError("Failed to load messages");
      loadingRef.current = false;
      setLoading(false);
      clearLoadingProgress();
    }
  }, [clearLoadingProgress, conversationId, messageCountStore, onConversationUpdate]);

  const setupMessageStream = useCallback(() => {
    const resetHeartbeatTimeout = () => {
      if (heartbeatTimeoutRef.current) {
        clearTimeout(heartbeatTimeoutRef.current);
      }
      heartbeatTimeoutRef.current = window.setTimeout(() => {
        console.warn("No heartbeat received in 60 seconds, reconnecting...");
        if (eventSourceRef.current) {
          eventSourceRef.current.close();
          eventSourceRef.current = null;
        }
        setupMessageStream();
      }, 60000);
    };

    if (!conversationId) return;

    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }
    if (heartbeatTimeoutRef.current) {
      clearTimeout(heartbeatTimeoutRef.current);
    }

    const lastEventId = lastEventIdRef.current;
    const eventSource = api.createMessageStream(
      conversationId,
      lastEventId > 0 ? lastEventId : undefined,
    );
    eventSourceRef.current = eventSource;

    eventSource.onmessage = (event) => {
      resetHeartbeatTimeout();
      setPauseAutoScroll(false);

      try {
        const streamEvent: StreamEventEnvelope = JSON.parse(event.data);
        const streamResponse = asStreamPayload(streamEvent);
        const incomingMessages = Array.isArray(streamResponse.messages)
          ? streamResponse.messages
          : [];

        if (
          typeof streamEvent.event_id === "number" &&
          streamEvent.event_id > lastEventIdRef.current
        ) {
          lastEventIdRef.current = streamEvent.event_id;
          conversationCache.updateLastEventId(conversationId, streamEvent.event_id);
        }

        if (incomingMessages.length > 0) {
          stopStreamingRender();
          setMessages((prev) => {
            const mergedMessages = mergeMessagesPreserveOrder(prev, incomingMessages);
            currentMessagesRef.current = mergedMessages;
            setLastKnownMessageCount(mergedMessages.length);
            messageCountStore.save(mergedMessages.length);
            return mergedMessages;
          });
          conversationCache.updateMessages(conversationId, incomingMessages);
        }

        if (streamResponse.conversation) {
          onConversationUpdate?.(streamResponse.conversation);
          conversationCache.updateConversation(conversationId, streamResponse.conversation);
        }

        if (streamResponse.conversation_list_update) {
          onConversationListUpdate?.(streamResponse.conversation_list_update);
        }

        if (streamResponse.conversation_state) {
          onConversationStateUpdate?.(streamResponse.conversation_state);
          if (streamResponse.conversation_state.conversation_id === conversationId) {
            setAgentWorking(streamResponse.conversation_state.working);
          }
        }

        if (streamResponse.notification_event) {
          handleNotificationEvent(streamResponse.notification_event);
        }

        if (typeof streamResponse.context_window_size === "number") {
          setContextWindowSize(streamResponse.context_window_size);
          conversationCache.updateContextWindowSize(
            conversationId,
            streamResponse.context_window_size,
          );
        }

        if (streamResponse.streaming_text !== undefined) {
          streamingTextRef.current += streamResponse.streaming_text;
          if (!streamingUpdateTimerRef.current) {
            streamingUpdateTimerRef.current = requestAnimationFrame(() => {
              setStreamingText(streamingTextRef.current);
              streamingUpdateTimerRef.current = null;
            });
          }
        }

        if (streamResponse.streaming_thinking !== undefined) {
          streamingThinkingRef.current += streamResponse.streaming_thinking;
          if (!streamingUpdateTimerRef.current) {
            streamingUpdateTimerRef.current = requestAnimationFrame(() => {
              setStreamingThinking(streamingThinkingRef.current);
              streamingUpdateTimerRef.current = null;
            });
          }
        }
      } catch (err) {
        console.error("Failed to parse message stream data:", err);
      }
    };

    eventSource.onerror = (event) => {
      console.warn("Message stream error (will retry):", event);
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      if (heartbeatTimeoutRef.current) {
        clearTimeout(heartbeatTimeoutRef.current);
        heartbeatTimeoutRef.current = null;
      }

      const delays = [1000, 2000, 5000];
      setReconnectAttempts((prev) => {
        const attempts = prev + 1;

        if (attempts > delays.length) {
          setIsReconnecting(false);
          setIsDisconnected(true);
          if (!periodicRetryRef.current) {
            periodicRetryRef.current = window.setInterval(() => {
              if (eventSourceRef.current === null) {
                console.log("Periodic reconnect attempt");
                setupMessageStream();
              }
            }, 30000);
          }
          return attempts;
        }

        setIsReconnecting(true);
        const delay = delays[attempts - 1];
        console.log(`Reconnecting in ${delay}ms (attempt ${attempts}/${delays.length})`);
        reconnectTimeoutRef.current = window.setTimeout(() => {
          if (eventSourceRef.current === null) {
            setupMessageStream();
          }
        }, delay);
        return attempts;
      });
    };

    eventSource.onopen = () => {
      console.log("Message stream connected");
      if (hasConnectedRef.current) {
        onReconnect?.();
      }
      hasConnectedRef.current = true;
      setReconnectAttempts(0);
      setIsDisconnected(false);
      setIsReconnecting(false);
      if (periodicRetryRef.current) {
        clearInterval(periodicRetryRef.current);
        periodicRetryRef.current = null;
      }
      resetHeartbeatTimeout();
    };
  }, [
    conversationId,
    messageCountStore,
    onConversationListUpdate,
    onConversationStateUpdate,
    onConversationUpdate,
    onReconnect,
    stopStreamingRender,
  ]);

  const forceReconnect = useCallback(() => {
    if (!conversationId) return;
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (periodicRetryRef.current) {
      clearInterval(periodicRetryRef.current);
      periodicRetryRef.current = null;
    }
    setIsDisconnected(false);
    setIsReconnecting(false);
    setReconnectAttempts(0);
    setupMessageStream();
  }, [conversationId, setupMessageStream]);

  const reconnect = useCallback(() => {
    if (!eventSourceRef.current || eventSourceRef.current.readyState === 2) {
      forceReconnect();
    }
  }, [forceReconnect]);

  const checkConnectionHealth = useCallback(() => {
    if (!conversationId) return false;
    const eventSource = eventSourceRef.current;
    if (!eventSource) return true;
    return eventSource.readyState === 2;
  }, [conversationId]);

  useEffect(() => {
    currentMessagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    if (conversationId) {
      setAgentWorking(false);
      loadMessages();
      setupMessageStream();
    } else {
      currentMessagesRef.current = [];
      setMessages([]);
      setContextWindowSize(0);
      setLastKnownMessageCount(null);
      loadingRef.current = false;
      setLoading(false);
      setPauseAutoScroll(false);
      clearLoadingProgress();
      stopStreamingRender();
    }

    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (periodicRetryRef.current) {
        clearInterval(periodicRetryRef.current);
      }
      if (heartbeatTimeoutRef.current) {
        clearTimeout(heartbeatTimeoutRef.current);
      }
      clearLoadingProgress();
      stopStreamingRender();
      if (conversationId && lastEventIdRef.current >= 0) {
        const cached = conversationCache.peek(conversationId);
        if (cached) {
          cached.lastEventId = lastEventIdRef.current;
        }
      }
      lastEventIdRef.current = 0;
      hasConnectedRef.current = false;
    };
  }, [clearLoadingProgress, conversationId, loadMessages, setupMessageStream, stopStreamingRender]);

  useEffect(() => {
    if (agentWorking) {
      setFaviconStatus("working");
    }
  }, [agentWorking]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        hiddenAtRef.current = Date.now();
        return;
      }

      const hiddenFor = hiddenAtRef.current ? Date.now() - hiddenAtRef.current : 0;
      hiddenAtRef.current = null;

      if (checkConnectionHealth()) {
        console.log("Tab visible: connection unhealthy, reconnecting");
        setPauseAutoScroll(true);
        reconnect();
      } else if (hiddenFor > 5000) {
        console.log(`Tab visible after ${Math.round(hiddenFor / 1000)}s hidden, force reconnecting`);
        setPauseAutoScroll(true);
        forceReconnect();
      }
    };

    const handleFocus = () => {
      if (checkConnectionHealth()) {
        console.log("Window focus: connection unhealthy, reconnecting");
        reconnect();
      }
    };

    const handleOnline = () => {
      if (checkConnectionHealth()) {
        console.log("Online: connection unhealthy, reconnecting");
        reconnect();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleFocus);
    window.addEventListener("online", handleOnline);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("online", handleOnline);
    };
  }, [checkConnectionHealth, forceReconnect, reconnect]);

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
        const errorMessage = err instanceof Error ? err.message : "Unknown error";
        setError(errorMessage);
        setAgentWorking(false);
        throw err;
      } finally {
        setSending(false);
      }
    },
    [conversationId, onFirstMessage, selectedCwd, selectedModel, sending],
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
  }, [cancelling, conversationId]);

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
