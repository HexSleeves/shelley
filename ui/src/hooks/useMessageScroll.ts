import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createConversationScrollStore } from "../services/conversationViewState";
import { Message } from "../types";

interface UseMessageScrollArgs {
  conversationId: string | null;
  messages: Message[];
  loading: boolean;
  navigateUserMessageTrigger?: number;
  pauseAutoScroll?: boolean;
}

interface UseMessageScrollResult {
  messagesContainerRef: RefObject<HTMLDivElement>;
  showScrollToBottom: boolean;
  scrollToBottom: () => void;
}

export function useMessageScroll({
  conversationId,
  messages,
  loading,
  navigateUserMessageTrigger,
  pauseAutoScroll = false,
}: UseMessageScrollArgs): UseMessageScrollResult {
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const userScrolledRef = useRef(false);
  const highlightTimeoutRef = useRef<number | null>(null);
  const pendingScrollRef = useRef<number | null | undefined>(undefined);
  const scrollSaveTimerRef = useRef<number | null>(null);

  const scrollStore = useMemo(
    () => createConversationScrollStore(conversationId),
    [conversationId],
  );

  const scrollToBottom = useCallback(() => {
    const container = messagesContainerRef.current;
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
    userScrolledRef.current = false;
    setShowScrollToBottom(false);
  }, []);

  useEffect(() => {
    pendingScrollRef.current = conversationId ? scrollStore.load() : null;
    userScrolledRef.current = false;
    setShowScrollToBottom(false);
  }, [conversationId, scrollStore]);

  useEffect(() => {
    const save = () => {
      const container = messagesContainerRef.current;
      if (!container || !conversationId) return;
      scrollStore.save(container.scrollTop);
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        save();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("beforeunload", save);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("beforeunload", save);
    };
  }, [conversationId, scrollStore]);

  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      const isNearBottom = scrollHeight - scrollTop - clientHeight < 100;
      setShowScrollToBottom(!isNearBottom);
      userScrolledRef.current = !isNearBottom;

      if (scrollSaveTimerRef.current) {
        clearTimeout(scrollSaveTimerRef.current);
      }
      scrollSaveTimerRef.current = window.setTimeout(() => {
        if (!loading) {
          scrollStore.save(container.scrollTop);
        }
      }, 100);
    };

    container.addEventListener("scroll", handleScroll);

    let lastScrollHeight = container.scrollHeight;
    const resizeObserver = new ResizeObserver(() => {
      if (container.scrollHeight === lastScrollHeight) return;
      lastScrollHeight = container.scrollHeight;
      if (!userScrolledRef.current && !pauseAutoScroll) {
        container.scrollTop = container.scrollHeight;
      }
    });

    const attachResizeObserver = () => {
      const list = container.querySelector(".messages-list");
      if (!list) return false;
      resizeObserver.observe(list);
      return true;
    };

    let mutationObserver: MutationObserver | null = null;
    if (!attachResizeObserver()) {
      mutationObserver = new MutationObserver((_, observer) => {
        if (attachResizeObserver()) {
          observer.disconnect();
          mutationObserver = null;
        }
      });
      mutationObserver.observe(container, { childList: true, subtree: true });
    }

    return () => {
      container.removeEventListener("scroll", handleScroll);
      if (scrollSaveTimerRef.current) {
        clearTimeout(scrollSaveTimerRef.current);
        scrollSaveTimerRef.current = null;
      }
      mutationObserver?.disconnect();
      resizeObserver.disconnect();
    };
  }, [loading, pauseAutoScroll, scrollStore]);

  useLayoutEffect(() => {
    if (loading) return;

    const pendingScroll = pendingScrollRef.current;
    if (pendingScroll !== undefined) {
      pendingScrollRef.current = undefined;
      if (pendingScroll != null) {
        const container = messagesContainerRef.current;
        if (container) {
          container.scrollTop = pendingScroll;
          const isNearBottom =
            container.scrollHeight - pendingScroll - container.clientHeight < 100;
          userScrolledRef.current = !isNearBottom;
          setShowScrollToBottom(!isNearBottom);
        }
      } else {
        scrollToBottom();
      }
      return;
    }

    if (!userScrolledRef.current && !pauseAutoScroll) {
      scrollToBottom();
    }
  }, [loading, messages, pauseAutoScroll, scrollToBottom]);

  useEffect(() => {
    if (!navigateUserMessageTrigger || !messagesContainerRef.current) return;

    const container = messagesContainerRef.current;
    const userMessageElements = container.querySelectorAll(".message-user");
    if (userMessageElements.length === 0) return;

    const direction = navigateUserMessageTrigger > 0 ? 1 : -1;
    const containerRect = container.getBoundingClientRect();
    const viewportTop = containerRect.top;
    let closestIndex = -1;
    let closestDistance = Infinity;

    userMessageElements.forEach((element, index) => {
      const rect = element.getBoundingClientRect();
      const distance = Math.abs(rect.top - viewportTop);
      if (distance < closestDistance) {
        closestDistance = distance;
        closestIndex = index;
      }
    });

    let targetIndex = closestIndex + direction;
    if (direction === 1 && closestIndex >= 0) {
      const rect = userMessageElements[closestIndex].getBoundingClientRect();
      if (rect.top > viewportTop + 50) {
        targetIndex = closestIndex;
      }
    }

    targetIndex = Math.max(0, Math.min(targetIndex, userMessageElements.length - 1));
    const targetElement = userMessageElements[targetIndex] as HTMLElement;
    targetElement.scrollIntoView({ behavior: "smooth", block: "start" });

    if (highlightTimeoutRef.current) {
      clearTimeout(highlightTimeoutRef.current);
      highlightTimeoutRef.current = null;
    }

    targetElement.classList.remove("message-highlight");
    void targetElement.offsetWidth;
    targetElement.classList.add("message-highlight");

    const removeHighlight = () => {
      targetElement.classList.remove("message-highlight");
      if (highlightTimeoutRef.current) {
        clearTimeout(highlightTimeoutRef.current);
        highlightTimeoutRef.current = null;
      }
    };

    targetElement.addEventListener("animationend", removeHighlight, { once: true });
    highlightTimeoutRef.current = window.setTimeout(removeHighlight, 2000) as unknown as number;

    return () => {
      if (highlightTimeoutRef.current) {
        clearTimeout(highlightTimeoutRef.current);
        highlightTimeoutRef.current = null;
      }
    };
  }, [navigateUserMessageTrigger]);

  return {
    messagesContainerRef,
    showScrollToBottom,
    scrollToBottom,
  };
}
