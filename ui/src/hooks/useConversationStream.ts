import { type MutableRefObject, useCallback, useEffect, useRef, useState } from "react";
import { conversationCache } from "../services/conversationCache";
import { handleNotificationEvent } from "../services/notifications";
import { Conversation, ConversationListUpdate, ConversationState, Message, StreamEventEnvelope, StreamResponse } from "../types";
import { api } from "../services/api";

function asStreamPayload(event: StreamEventEnvelope): StreamResponse {
  if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) {
    return {} as StreamResponse;
  }
  return event.payload as StreamResponse;
}

function shouldClearWorkingFromMessages(messages: Message[]): boolean {
  return messages.some((message) => {
    if ((message.type === "agent" || message.type === "error") && message.end_of_turn) {
      return true;
    }
    return message.type === "error";
  });
}

interface UseConversationStreamArgs {
  conversationId: string | null;
  lastEventIdRef: MutableRefObject<number>;
  setAgentWorking: (working: boolean) => void;
  onSelectedModelChange?: (model: string) => void;
  applyIncomingMessages: (incomingMessages: Message[]) => void;
  applyConversationUpdate: (conversation: Conversation) => void;
  applyContextWindowSize: (size: number) => void;
  onConversationListUpdate?: (update: ConversationListUpdate) => void;
  onConversationStateUpdate?: (state: ConversationState) => void;
  onReconnect?: () => void;
}

interface UseConversationStreamResult {
  reconnectAttempts: number;
  isDisconnected: boolean;
  isReconnecting: boolean;
  pauseAutoScroll: boolean;
  streamingText: string;
  streamingThinking: string;
  reconnect: () => void;
  resetStreamState: () => void;
}

export function useConversationStream({
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
}: UseConversationStreamArgs): UseConversationStreamResult {
  const [reconnectAttempts, setReconnectAttempts] = useState(0);
  const [isDisconnected, setIsDisconnected] = useState(false);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [pauseAutoScroll, setPauseAutoScroll] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [streamingThinking, setStreamingThinking] = useState("");
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const periodicRetryRef = useRef<number | null>(null);
  const heartbeatTimeoutRef = useRef<number | null>(null);
  const hasConnectedRef = useRef(false);
  const hiddenAtRef = useRef<number | null>(null);
  const streamingTextRef = useRef("");
  const streamingThinkingRef = useRef("");
  const streamingUpdateTimerRef = useRef<number | null>(null);
  const onSelectedModelChangeRef = useRef(onSelectedModelChange);
  const onConversationListUpdateRef = useRef(onConversationListUpdate);
  const onConversationStateUpdateRef = useRef(onConversationStateUpdate);
  const onReconnectRef = useRef(onReconnect);

  useEffect(() => {
    onSelectedModelChangeRef.current = onSelectedModelChange;
  }, [onSelectedModelChange]);

  useEffect(() => {
    onConversationListUpdateRef.current = onConversationListUpdate;
  }, [onConversationListUpdate]);

  useEffect(() => {
    onConversationStateUpdateRef.current = onConversationStateUpdate;
  }, [onConversationStateUpdate]);

  useEffect(() => {
    onReconnectRef.current = onReconnect;
  }, [onReconnect]);

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

    eventSourceRef.current = api.createMessageStream(
      conversationId,
      lastEventIdRef.current > 0 ? lastEventIdRef.current : undefined,
    );

    eventSourceRef.current.onmessage = (event) => {
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
          applyIncomingMessages(incomingMessages);
        }

        if (streamResponse.conversation) {
          applyConversationUpdate(streamResponse.conversation);
        }

        if (streamResponse.conversation_list_update) {
          onConversationListUpdateRef.current?.(streamResponse.conversation_list_update);
        }

        if (streamResponse.conversation_state) {
          onConversationStateUpdateRef.current?.(streamResponse.conversation_state);
          if (streamResponse.conversation_state.conversation_id === conversationId) {
            if (
              streamResponse.conversation_state.working === false ||
              shouldClearWorkingFromMessages(incomingMessages)
            ) {
              setAgentWorking(false);
            } else {
              setAgentWorking(true);
            }
            if (streamResponse.conversation_state.model) {
              onSelectedModelChangeRef.current?.(streamResponse.conversation_state.model);
            }
          }
        }

        if (streamResponse.notification_event) {
          handleNotificationEvent(streamResponse.notification_event);
        }

        if (typeof streamResponse.context_window_size === "number") {
          applyContextWindowSize(streamResponse.context_window_size);
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

    eventSourceRef.current.onerror = (event) => {
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
                setupMessageStream();
              }
            }, 30000);
          }
          return attempts;
        }

        setIsReconnecting(true);
        reconnectTimeoutRef.current = window.setTimeout(() => {
          if (eventSourceRef.current === null) {
            setupMessageStream();
          }
        }, delays[attempts - 1]);
        return attempts;
      });
    };

    eventSourceRef.current.onopen = () => {
      if (hasConnectedRef.current) {
        onReconnectRef.current?.();
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
    applyContextWindowSize,
    applyConversationUpdate,
    applyIncomingMessages,
    conversationId,
    lastEventIdRef,
    setAgentWorking,
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
    if (!eventSourceRef.current) return true;
    return eventSourceRef.current.readyState === 2;
  }, [conversationId]);

  useEffect(() => {
    if (!conversationId) {
      stopStreamingRender();
      setPauseAutoScroll(false);
      return;
    }
    setupMessageStream();

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
      stopStreamingRender();
      hasConnectedRef.current = false;
    };
  }, [conversationId, setupMessageStream, stopStreamingRender]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        hiddenAtRef.current = Date.now();
        return;
      }
      const hiddenFor = hiddenAtRef.current ? Date.now() - hiddenAtRef.current : 0;
      hiddenAtRef.current = null;
      if (checkConnectionHealth()) {
        setPauseAutoScroll(true);
        reconnect();
      } else if (hiddenFor > 5000) {
        setPauseAutoScroll(true);
        forceReconnect();
      }
    };

    const handleFocus = () => {
      if (checkConnectionHealth()) {
        reconnect();
      }
    };

    const handleOnline = () => {
      if (checkConnectionHealth()) {
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

  return {
    reconnectAttempts,
    isDisconnected,
    isReconnecting,
    pauseAutoScroll,
    streamingText,
    streamingThinking,
    reconnect,
    resetStreamState: stopStreamingRender,
  };
}
