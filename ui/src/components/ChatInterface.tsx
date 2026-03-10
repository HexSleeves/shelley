import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  Message,
  Conversation,
  ConversationState,
  LLMContent,
  ConversationListUpdate,
  isDistillStatusMessage,
} from "../types";
import { api } from "../services/api";
import { ThemeMode, getStoredTheme, setStoredTheme, applyTheme } from "../services/theme";
import { useMarkdown } from "../contexts/MarkdownContext";
import { useI18n, type Locale, type TranslationKeys } from "../i18n";
import {
  isChannelEnabled,
  setChannelEnabled,
  getBrowserNotificationState,
  requestBrowserNotificationPermission,
} from "../services/notifications";
import MessageComponent from "./Message";
import MessageInput from "./MessageInput";
import DiffViewer from "./DiffViewer";
import DirectoryPickerModal from "./DirectoryPickerModal";
import { useVersionChecker } from "./VersionChecker";
import ThinkingContent from "./ThinkingContent";
import MarkdownContent from "./MarkdownContent";
import TerminalPanel, { EphemeralTerminal } from "./TerminalPanel";
import ModelPicker from "./ModelPicker";
import SystemPromptView from "./SystemPromptView";
import { renderToolCall, formatExecutionTime } from "./toolRendering";
import { useComposerPreferences } from "../hooks/useComposerPreferences";
import { useConversationSession } from "../hooks/useConversationSession";
import { useMessageScroll } from "../hooks/useMessageScroll";

interface ContextUsageBarProps {
  contextWindowSize: number;
  maxContextTokens: number;
  conversationId?: string | null;
  modelName?: string;
  onDistillConversation?: () => void;
  agentWorking?: boolean;
}

function ContextUsageBar({
  contextWindowSize,
  maxContextTokens,
  conversationId,
  modelName,
  onDistillConversation,
  agentWorking,
}: ContextUsageBarProps) {
  const [showPopup, setShowPopup] = useState(false);
  const [distilling, setDistilling] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);
  const hasAutoOpenedRef = useRef<string | null>(null);

  const percentage = maxContextTokens > 0 ? (contextWindowSize / maxContextTokens) * 100 : 0;
  const clampedPercentage = Math.min(percentage, 100);
  const showLongConversationWarning = contextWindowSize >= 100000;

  const getBarColor = () => {
    if (percentage >= 90) return "var(--error-text)";
    if (percentage >= 70) return "var(--warning-text, #f59e0b)";
    return "var(--blue-text)";
  };

  const formatTokens = (tokens: number) => {
    if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M`;
    if (tokens >= 1000) return `${(tokens / 1000).toFixed(0)}k`;
    return tokens.toString();
  };

  const handleClick = () => {
    setShowPopup(!showPopup);
  };

  // Auto-open popup when hitting 100k tokens (once per conversation).
  // Only auto-open at end of turn (when agent is not working) so we don't
  // interrupt the user while the agent is plugging away.
  useEffect(() => {
    if (
      showLongConversationWarning &&
      !agentWorking &&
      conversationId &&
      hasAutoOpenedRef.current !== conversationId
    ) {
      hasAutoOpenedRef.current = conversationId;
      setShowPopup(true);
    }
  }, [showLongConversationWarning, agentWorking, conversationId]);

  // Close popup when clicking outside
  useEffect(() => {
    if (!showPopup) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) {
        setShowPopup(false);
      }
    };
    document.addEventListener("click", handleClickOutside);
    return () => document.removeEventListener("click", handleClickOutside);
  }, [showPopup]);

  // Calculate fixed position when popup should be shown
  const [popupPosition, setPopupPosition] = useState<{ bottom: number; right: number } | null>(
    null,
  );

  useEffect(() => {
    if (showPopup && barRef.current) {
      const rect = barRef.current.getBoundingClientRect();
      setPopupPosition({
        bottom: window.innerHeight - rect.top + 4,
        right: window.innerWidth - rect.right,
      });
    } else {
      setPopupPosition(null);
    }
  }, [showPopup]);

  const handleDistill = async () => {
    if (distilling || !onDistillConversation) return;
    setDistilling(true);
    try {
      await onDistillConversation();
      setShowPopup(false);
    } finally {
      setDistilling(false);
    }
  };

  return (
    <div ref={barRef}>
      {showPopup && popupPosition && (
        <div
          style={{
            position: "fixed",
            bottom: popupPosition.bottom,
            right: popupPosition.right,
            maxWidth: `calc(100vw - ${popupPosition.right + 8}px)`,
            padding: "6px 10px",
            backgroundColor: "var(--bg-secondary)",
            border: "1px solid var(--border-color)",
            borderRadius: "4px",
            fontSize: "12px",
            color: "var(--text-secondary)",
            boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
            zIndex: 100,
          }}
        >
          {modelName && (
            <div style={{ fontWeight: 500, color: "var(--text-primary)", marginBottom: "4px" }}>
              {modelName}
            </div>
          )}
          {formatTokens(contextWindowSize)} / {formatTokens(maxContextTokens)} (
          {percentage.toFixed(1)}%) tokens used
          {showLongConversationWarning && (
            <div style={{ marginTop: "6px", color: "var(--warning-text, #f59e0b)" }}>
              This conversation is getting long.
              <br />
              For best results, start a new conversation.
            </div>
          )}
          {onDistillConversation && conversationId && (
            <div style={{ display: "flex", gap: "6px", marginTop: "8px" }}>
              <button
                onClick={handleDistill}
                disabled={distilling}
                style={{
                  padding: "4px 8px",
                  backgroundColor: "var(--blue-text)",
                  color: "white",
                  border: "none",
                  borderRadius: "4px",
                  cursor: distilling ? "not-allowed" : "pointer",
                  fontSize: "12px",
                  opacity: distilling ? 0.7 : 1,
                }}
              >
                {distilling ? "Distilling..." : "Distill & Continue in New Conversation"}
              </button>
            </div>
          )}
        </div>
      )}
      <div className="context-usage-bar-container">
        {showLongConversationWarning && (
          <span
            className="context-warning-icon"
            title="This conversation is getting long. For best results, start a new conversation."
          >
            ⚠️
          </span>
        )}
        <div
          className="context-usage-bar"
          onClick={handleClick}
          title={`Context: ${formatTokens(contextWindowSize)} / ${formatTokens(maxContextTokens)} tokens (${percentage.toFixed(1)}%)`}
        >
          <div
            className="context-usage-fill"
            style={{
              width: `${clampedPercentage}%`,
              backgroundColor: getBarColor(),
            }}
          />
        </div>
      </div>
    </div>
  );
}

interface CoalescedItem {
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

interface CoalescedToolCallProps {
  toolName: string;
  toolInput?: unknown;
  toolResult?: LLMContent[];
  toolError?: boolean;
  toolStartTime?: string | null;
  toolEndTime?: string | null;
  hasResult?: boolean;
  display?: unknown;
  onCommentTextChange?: (text: string) => void;
}

const CoalescedToolCall = React.memo(function CoalescedToolCall({
  toolName,
  toolInput,
  toolResult,
  toolError,
  toolStartTime,
  toolEndTime,
  hasResult,
  display,
  onCommentTextChange,
}: CoalescedToolCallProps) {
  const executionTime =
    hasResult && toolStartTime && toolEndTime
      ? formatExecutionTime(toolStartTime, toolEndTime)
      : "";

  const getToolResultSummary = (results: LLMContent[]) => {
    if (!results || results.length === 0) return "No output";

    const firstResult = results[0];
    if (firstResult.Type === 2 && firstResult.Text) {
      // text content
      const text = firstResult.Text.trim();
      if (text.length <= 50) return text;
      return text.substring(0, 47) + "...";
    }

    return `${results.length} result${results.length > 1 ? "s" : ""}`;
  };

  const renderContent = (content: LLMContent) => {
    if (content.Type === 2) {
      // text
      return <div className="whitespace-pre-wrap break-words">{content.Text || ""}</div>;
    }
    return <div className="text-secondary text-sm italic">[Content type {content.Type}]</div>;
  };

  if (!hasResult) {
    // Show "running" state
    return (
      <div className="message message-tool" data-testid="tool-call-running">
        <div className="message-content">
          <div className="tool-running">
            <div className="tool-running-header">
              <svg
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                style={{ width: "1rem", height: "1rem", color: "var(--blue-text)" }}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
                />
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                />
              </svg>
              <span className="tool-name">Tool: {toolName}</span>
              <span className="tool-status-running">(running)</span>
            </div>
            <div className="tool-input">
              {typeof toolInput === "string" ? toolInput : JSON.stringify(toolInput, null, 2)}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Show completed state with result
  const summary = toolResult ? getToolResultSummary(toolResult) : "No output";

  return (
    <div className="message message-tool" data-testid="tool-call-completed">
      <div className="message-content">
        {renderToolCall({
          toolName,
          toolInput,
          isRunning: false,
          toolResult,
          hasError: toolError,
          executionTime,
          display,
          onCommentTextChange,
          fallback: "none",
        }) || (
          <details className={`tool-result-details ${toolError ? "error" : ""}`}>
            <summary className="tool-result-summary">
              <div className="tool-result-meta">
                <div className="flex items-center space-x-2">
                  <svg
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    style={{ width: "1rem", height: "1rem", color: "var(--blue-text)" }}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
                    />
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                    />
                  </svg>
                  <span className="text-sm font-medium text-blue">{toolName}</span>
                  <span className={`tool-result-status text-xs ${toolError ? "error" : "success"}`}>
                    {toolError ? "✗" : "✓"} {summary}
                  </span>
                </div>
                <div className="tool-result-time">
                  {executionTime && <span>{executionTime}</span>}
                </div>
              </div>
            </summary>
            <div className="tool-result-content">
              <div className="tool-result-section">
                <div className="tool-result-label">Input:</div>
                <div className="tool-result-data">
                  {toolInput ? (
                    typeof toolInput === "string" ? (
                      toolInput
                    ) : (
                      JSON.stringify(toolInput, null, 2)
                    )
                  ) : (
                    <span className="text-secondary italic">No input data</span>
                  )}
                </div>
              </div>
              <div className={`tool-result-section output ${toolError ? "error" : ""}`}>
                <div className="tool-result-label">Output{toolError ? " (Error)" : ""}:</div>
                <div className="space-y-2">
                  {toolResult?.map((result, idx) => (
                    <div key={idx}>{renderContent(result)}</div>
                  ))}
                </div>
              </div>
            </div>
          </details>
        )}
      </div>
    </div>
  );
});

// Animated "Agent working..." with letter-by-letter bold animation
function AnimatedWorkingStatus() {
  const text = "Agent working...";
  const [boldIndex, setBoldIndex] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setBoldIndex((prev) => (prev + 1) % text.length);
    }, 100); // 100ms per letter
    return () => clearInterval(interval);
  }, []);

  return (
    <span className="status-message animated-working">
      {text.split("").map((char, idx) => (
        <span key={idx} className={idx === boldIndex ? "bold-letter" : ""}>
          {char}
        </span>
      ))}
    </span>
  );
}

interface ChatInterfaceProps {
  conversationId: string | null;
  onOpenDrawer: () => void;
  onNewConversation: () => void;
  onArchiveConversation?: (conversationId: string) => Promise<void>;
  currentConversation?: Conversation;
  onConversationUpdate?: (conversation: Conversation) => void;
  onConversationListUpdate?: (update: ConversationListUpdate) => void;
  onConversationStateUpdate?: (state: ConversationState) => void;
  onFirstMessage?: (message: string, model: string, cwd?: string) => Promise<void>;
  onDistillConversation?: (
    sourceConversationId: string,
    model: string,
    cwd?: string,
  ) => Promise<void>;
  mostRecentCwd?: string | null;
  isDrawerCollapsed?: boolean;
  onToggleDrawerCollapse?: () => void;
  openDiffViewerTrigger?: number; // increment to trigger opening diff viewer
  modelsRefreshTrigger?: number; // increment to trigger models list refresh
  onOpenModelsModal?: () => void;
  onReconnect?: () => void;
  ephemeralTerminals: EphemeralTerminal[];
  setEphemeralTerminals: React.Dispatch<React.SetStateAction<EphemeralTerminal[]>>;
  navigateUserMessageTrigger?: number; // positive = next, negative = previous
  onConversationUnarchived?: (conversation: Conversation) => void;
}

const LANGUAGE_OPTIONS: { locale: Locale; flag: string; label: string }[] = [
  { locale: "en", flag: "🇺🇸", label: "English" },
  { locale: "ja", flag: "🇯🇵", label: "日本語" },
  { locale: "fr", flag: "🇫🇷", label: "Français" },
  { locale: "ru", flag: "🇷🇺", label: "Русский" },
  { locale: "es", flag: "🇪🇸", label: "Español" },
  { locale: "upgoer5", flag: "🚀", label: "Up-Goer Five" },
];

function LanguageDropdown({
  locale,
  setLocale,
  t,
}: {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (key: keyof TranslationKeys) => string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = LANGUAGE_OPTIONS.find((o) => o.locale === locale)!;

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div className="language-dropdown" ref={ref}>
      <button
        className="language-dropdown-trigger"
        onClick={() => setOpen(!open)}
        aria-label={t("switchLanguage")}
      >
        <span className="language-dropdown-flag">{current.flag}</span>
        <span className="language-dropdown-text">{current.label}</span>
        <svg
          className={`language-dropdown-chevron${open ? " language-dropdown-chevron-open" : ""}`}
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
        >
          <path
            d="M3 4.5L6 7.5L9 4.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open && (
        <div className="language-dropdown-menu">
          {LANGUAGE_OPTIONS.map((opt) => (
            <button
              key={opt.locale}
              className={`language-dropdown-item${opt.locale === locale ? " language-dropdown-item-selected" : ""}`}
              onClick={() => {
                setLocale(opt.locale);
                setOpen(false);
              }}
            >
              <span className="language-dropdown-flag">{opt.flag}</span>
              <span>{opt.label}</span>
              {opt.locale === locale && (
                <svg
                  className="language-dropdown-check"
                  width="14"
                  height="14"
                  viewBox="0 0 14 14"
                  fill="none"
                >
                  <path
                    d="M3 7L6 10L11 4"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function ChatInterface({
  conversationId,
  onOpenDrawer,
  onNewConversation,
  onArchiveConversation,
  currentConversation,
  onConversationUpdate,
  onConversationListUpdate,
  onConversationStateUpdate,
  onFirstMessage,
  onDistillConversation,
  mostRecentCwd,
  isDrawerCollapsed,
  onToggleDrawerCollapse,
  openDiffViewerTrigger,
  modelsRefreshTrigger,
  onOpenModelsModal,
  onReconnect,
  ephemeralTerminals,
  setEphemeralTerminals,
  navigateUserMessageTrigger,
  onConversationUnarchived,
}: ChatInterfaceProps) {
  const {
    models,
    selectedModel,
    setSelectedModel,
    selectedCwd,
    setSelectedCwd,
    cwdError,
    setCwdError,
  } = useComposerPreferences({
    conversationId,
    currentConversation,
    mostRecentCwd,
    modelsRefreshTrigger,
  });
  const {
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
  } = useConversationSession({
    conversationId,
    selectedModel,
    selectedCwd,
    onConversationUpdate,
    onConversationListUpdate,
    onConversationStateUpdate,
    onFirstMessage,
    onReconnect,
  });
  const { messagesContainerRef, showScrollToBottom, scrollToBottom } = useMessageScroll({
    conversationId,
    messages,
    loading,
    navigateUserMessageTrigger,
    pauseAutoScroll,
  });
  const [showDirectoryPicker, setShowDirectoryPicker] = useState(false);
  // Settings modal removed - configuration moved to status bar for empty conversations
  const [showOverflowMenu, setShowOverflowMenu] = useState(false);
  const [themeMode, setThemeMode] = useState<ThemeMode>(getStoredTheme);
  const { markdownMode, setMarkdownMode } = useMarkdown();
  const { t, locale, setLocale } = useI18n();
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  const [browserNotifsEnabled, setBrowserNotifsEnabled] = useState(() =>
    isChannelEnabled("browser"),
  );
  const [showDiffViewer, setShowDiffViewer] = useState(false);
  const [diffViewerInitialCommit, setDiffViewerInitialCommit] = useState<string | undefined>(
    undefined,
  );
  const [diffViewerCwd, setDiffViewerCwd] = useState<string | undefined>(undefined);
  const [diffCommentText, setDiffCommentText] = useState("");
  const terminalURL = window.__SHELLEY_INIT__?.terminal_url || null;
  const links = window.__SHELLEY_INIT__?.links || [];
  const hostname = window.__SHELLEY_INIT__?.hostname || "localhost";
  const { hasUpdate, openModal: openVersionModal, VersionModal } = useVersionChecker();
  const [terminalInjectedText, setTerminalInjectedText] = useState<string | null>(null);
  const [terminalAutoFocusId, setTerminalAutoFocusId] = useState<string | null>(null);
  const overflowMenuRef = useRef<HTMLDivElement>(null);

  const handleOpenDiffViewer = useCallback((commit: string, cwd?: string) => {
    setDiffViewerInitialCommit(commit);
    setDiffViewerCwd(cwd);
    setShowDiffViewer(true);
  }, []);

  // Close overflow menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (overflowMenuRef.current && !overflowMenuRef.current.contains(event.target as Node)) {
        setShowOverflowMenu(false);
      }
    };

    if (showOverflowMenu) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => {
        document.removeEventListener("mousedown", handleClickOutside);
      };
    }
  }, [showOverflowMenu]);

  const sendMessage = async (message: string) => {
    if (!message.trim() || sending) return;

    const trimmedMessage = message.trim();
    if (trimmedMessage.startsWith("!")) {
      const shellCommand = trimmedMessage.slice(1).trim();
      if (shellCommand) {
        const terminal: EphemeralTerminal = {
          id: `term-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          command: shellCommand,
          cwd:
            currentConversation?.cwd || selectedCwd || window.__SHELLEY_INIT__?.default_cwd || "/",
          createdAt: new Date(),
        };
        setEphemeralTerminals((prev) => [...prev, terminal]);
        const firstWord = shellCommand.split(/\s+/)[0];
        const baseName = firstWord.split("/").pop() || firstWord;
        const interactiveShells = ["bash", "sh", "zsh", "fish", "nu", "nushell"];
        if (interactiveShells.includes(baseName)) {
          setTerminalAutoFocusId(terminal.id);
        }
        setTimeout(() => scrollToBottom(), 100);
      }
      return;
    }

    await sendConversationMessage(message);
  };

  // Callback for terminals to insert text into the message input
  const handleInsertFromTerminal = useCallback((text: string) => {
    setTerminalInjectedText(text);
  }, []);

  // Handle external trigger to open diff viewer
  useEffect(() => {
    if (openDiffViewerTrigger && openDiffViewerTrigger > 0) {
      setShowDiffViewer(true);
    }
  }, [openDiffViewerTrigger]);

  const handleCancel = cancelConversation;

  // Handler to distill and continue conversation
  const handleDistillConversation = async () => {
    if (!conversationId || !onDistillConversation) return;
    await onDistillConversation(
      conversationId,
      selectedModel,
      currentConversation?.cwd || selectedCwd || undefined,
    );
  };

  // Get the display name for the selected model
  const selectedModelDisplayName = (() => {
    const modelObj = models.find((m) => m.id === selectedModel);
    return modelObj?.display_name || selectedModel;
  })();

  const handleUnarchive = async () => {
    if (!conversationId) return;
    try {
      const conversation = await api.unarchiveConversation(conversationId);
      onConversationUnarchived?.(conversation);
    } catch (err) {
      console.error("Failed to unarchive conversation:", err);
    }
  };

  const getDisplayTitle = () => {
    const title = currentConversation?.slug || "Shelley";
    if (currentConversation?.archived) {
      return `${title} (archived)`;
    }
    return title;
  };

  // Process messages to coalesce tool calls (memoized to avoid re-parsing on every render)
  const coalescedItems = useMemo(() => {
    if (messages.length === 0) {
      return [] as CoalescedItem[];
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

    // First pass: collect all tool results and their display data from llm_data
    messages.forEach((message) => {
      if (message.llm_data) {
        try {
          const llmData =
            typeof message.llm_data === "string" ? JSON.parse(message.llm_data) : message.llm_data;
          if (llmData && llmData.Content && Array.isArray(llmData.Content)) {
            llmData.Content.forEach((content: LLMContent) => {
              if (content && content.Type === 6 && content.ToolUseID) {
                // tool_result
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
          }
        } catch (err) {
          console.error("Failed to parse message LLM data for tool results:", err);
        }
      }
    });

    // Second pass: process messages and extract tool uses
    messages.forEach((message) => {
      // Allow system messages with distill_status through, skip others
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

      // Check if this is a user message with tool results (skip rendering them as messages)
      let hasToolResult = false;
      if (message.llm_data) {
        try {
          const llmData =
            typeof message.llm_data === "string" ? JSON.parse(message.llm_data) : message.llm_data;
          if (llmData && llmData.Content && Array.isArray(llmData.Content)) {
            hasToolResult = llmData.Content.some((c: LLMContent) => c.Type === 6);
          }
        } catch (err) {
          console.error("Failed to parse message LLM data:", err);
        }
      }

      // If it's a user message without tool results, show it
      if (message.type === "user" && !hasToolResult) {
        items.push({ type: "message", message });
        return;
      }

      // If it's a user message with tool results, skip it (we'll handle it via the toolResultMap)
      if (message.type === "user" && hasToolResult) {
        return;
      }

      if (message.llm_data) {
        try {
          const llmData =
            typeof message.llm_data === "string" ? JSON.parse(message.llm_data) : message.llm_data;
          if (llmData && llmData.Content && Array.isArray(llmData.Content)) {
            const renderableContents: LLMContent[] = [];
            const toolUses: LLMContent[] = [];

            llmData.Content.forEach((content: LLMContent) => {
              if (content.Type === 2 || content.Type === 3 || content.Type === 4) {
                renderableContents.push(content);
              } else if (content.Type === 5) {
                // tool_use
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
              const renderableMessage: Message = {
                ...message,
                llm_data: JSON.stringify({
                  ...llmData,
                  Content: renderableContents,
                }),
              };
              items.push({ type: "message", message: renderableMessage });
            }

            // Check if this message was truncated (tool calls lost)
            const wasTruncated = llmData.ExcludedFromContext === true;

            // Add tool uses as separate items
            toolUses.forEach((toolUse) => {
              const resultData = toolUse.ID ? toolResultMap[toolUse.ID] : undefined;
              const displayData = toolUse.ID ? displayDataMap[toolUse.ID] : undefined;
              items.push({
                type: "tool",
                toolUseId: toolUse.ID,
                toolName: toolUse.ToolName,
                toolInput: toolUse.ToolInput,
                toolResult: resultData?.result,
                // Mark as error if truncated and no result
                toolError: resultData?.error || (wasTruncated && !resultData),
                toolStartTime: resultData?.startTime,
                toolEndTime: resultData?.endTime,
                // Mark as complete if truncated (tool was lost, not running)
                hasResult: !!resultData || wasTruncated,
                display: displayData,
              });
            });
          }
        } catch (err) {
          console.error("Failed to parse message LLM data:", err);
          items.push({ type: "message", message });
        }
      } else {
        items.push({ type: "message", message });
      }
    });

    return items;
  }, [messages]);

  const renderMessages = () => {
    if (messages.length === 0) {
      const proxyURL = `https://${hostname}/`;
      return (
        <div className="empty-state">
          <div className="empty-state-content">
            <p className="text-base" style={{ marginBottom: "1rem", lineHeight: "1.6" }}>
              {t("welcomeMessage")
                .split(/(\{hostname\}|\{docsLink\}|\{proxyLink\})/)
                .map((part, i) => {
                  if (part === "{hostname}") return <strong key={i}>{hostname}</strong>;
                  if (part === "{docsLink}")
                    return (
                      <a
                        key={i}
                        href="https://exe.dev/docs/proxy"
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ color: "var(--blue-text)", textDecoration: "underline" }}
                      >
                        docs
                      </a>
                    );
                  if (part === "{proxyLink}")
                    return (
                      <a
                        key={i}
                        href={proxyURL}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ color: "var(--blue-text)", textDecoration: "underline" }}
                      >
                        {proxyURL}
                      </a>
                    );
                  return part;
                })}
            </p>
            {models.length === 0 ? (
              <div className="add-model-hint">
                <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
                  {t("noModelsConfiguredHint")}
                </p>
              </div>
            ) : (
              <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
                {t("sendMessageToStart")}
              </p>
            )}
          </div>
        </div>
      );
    }

    const rendered = coalescedItems.map((item, index) => {
      if (item.type === "message" && item.message) {
        return (
          <MessageComponent
            key={item.message.message_id}
            message={item.message}
            onOpenDiffViewer={handleOpenDiffViewer}
            onCommentTextChange={setDiffCommentText}
          />
        );
      } else if (item.type === "tool") {
        return (
          <CoalescedToolCall
            key={item.toolUseId || `tool-${index}`}
            toolName={item.toolName || "Unknown Tool"}
            toolInput={item.toolInput}
            toolResult={item.toolResult}
            toolError={item.toolError}
            toolStartTime={item.toolStartTime}
            toolEndTime={item.toolEndTime}
            hasResult={item.hasResult}
            display={item.display}
            onCommentTextChange={setDiffCommentText}
          />
        );
      }
      return null;
    });

    // Find system prompt message to render at the top (exclude distill status messages)
    const systemMessage = messages.find((m) => m.type === "system" && !isDistillStatusMessage(m));

    return [
      systemMessage && <SystemPromptView key="system-prompt" message={systemMessage} />,
      ...rendered,
    ];
  };

  // Status bar content — rendered in the standalone status bar (desktop) and
  // inline in the message input controls row (mobile via CSS).
  function renderStatusContent() {
    return currentConversation?.archived ? (
      // Archived state
      <>
        <span className="status-message">This conversation is archived.</span>
        <button onClick={handleUnarchive} className="status-button status-button-primary">
          Unarchive
        </button>
      </>
    ) : isDisconnected ? (
      // Disconnected state
      <>
        <span className="status-message status-warning">Disconnected</span>
        <button onClick={reconnect} className="status-button status-button-primary">
          Retry
        </button>
      </>
    ) : isReconnecting ? (
      // Reconnecting state
      <>
        <span className="status-message status-reconnecting">
          Reconnecting{reconnectAttempts > 0 ? ` (${reconnectAttempts}/3)` : ""}
          <span className="reconnecting-dots">...</span>
        </span>
      </>
    ) : error ? (
      // Error state
      <>
        <span className="status-message status-error">{error}</span>
        <button onClick={() => setError(null)} className="status-button status-button-text">
          <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>
      </>
    ) : agentWorking && conversationId ? (
      // Agent working — show status with stop button and context bar
      <div className="status-bar-active" data-testid="agent-thinking">
        <div className="status-working-group">
          <AnimatedWorkingStatus />
          <button
            onClick={handleCancel}
            disabled={cancelling}
            className="status-stop-button"
            title={cancelling ? "Cancelling..." : "Stop"}
          >
            <svg viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="6" width="12" height="12" rx="1" />
            </svg>
            <span className="status-stop-label">{cancelling ? "Cancelling..." : "Stop"}</span>
          </button>
        </div>
        <ContextUsageBar
          contextWindowSize={contextWindowSize}
          maxContextTokens={
            models.find((m) => m.id === selectedModel)?.max_context_tokens || 200000
          }
          conversationId={conversationId}
          modelName={selectedModelDisplayName}
          onDistillConversation={onDistillConversation ? handleDistillConversation : undefined}
          agentWorking={agentWorking}
        />
      </div>
    ) : !conversationId ? (
      // New conversation — show model picker and cwd selector
      <div className="status-bar-new-conversation">
        <div
          className="status-field status-field-model"
          title="AI model to use for this conversation"
        >
          <span className="status-field-label">{t("modelLabel")}</span>
          <ModelPicker
            models={models}
            selectedModel={selectedModel}
            onSelectModel={setSelectedModel}
            onManageModels={() => onOpenModelsModal?.()}
            disabled={sending}
          />
        </div>
        <div
          className={`status-field status-field-cwd${cwdError ? " status-field-error" : ""}`}
          title={cwdError || "Working directory for file operations"}
        >
          <span className="status-field-label">{t("dirLabel")}</span>
          <button
            className={`status-chip${cwdError ? " status-chip-error" : ""}`}
            onClick={() => setShowDirectoryPicker(true)}
            disabled={sending}
          >
            {selectedCwd || "(no cwd)"}
          </button>
        </div>
      </div>
    ) : (
      // Active conversation — show ready message and context bar
      <div className="status-bar-active">
        <span className="status-message status-ready">
          <span className="hide-on-mobile">Ready on </span>
          {hostname}
        </span>
        <ContextUsageBar
          contextWindowSize={contextWindowSize}
          maxContextTokens={
            models.find((m) => m.id === selectedModel)?.max_context_tokens || 200000
          }
          conversationId={conversationId}
          modelName={selectedModelDisplayName}
          onDistillConversation={onDistillConversation ? handleDistillConversation : undefined}
          agentWorking={agentWorking}
        />
      </div>
    );
  }

  return (
    <div className="full-height flex flex-col">
      {/* Header */}
      <div className="header">
        <div className="header-left">
          <button
            onClick={onOpenDrawer}
            className="btn-icon hide-on-desktop"
            aria-label={t("openConversations")}
          >
            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 6h16M4 12h16M4 18h16"
              />
            </svg>
          </button>

          {/* Expand drawer button - desktop only when collapsed */}
          {isDrawerCollapsed && onToggleDrawerCollapse && (
            <button
              onClick={onToggleDrawerCollapse}
              className="btn-icon show-on-desktop-only"
              aria-label={t("expandSidebar")}
              title={t("expandSidebar")}
            >
              <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M13 5l7 7-7 7M5 5l7 7-7 7"
                />
              </svg>
            </button>
          )}

          <h1 className="header-title" title={currentConversation?.slug || "Shelley"}>
            {getDisplayTitle()}
          </h1>
        </div>

        <div className="header-actions">
          {/* Green + icon in circle for new conversation */}
          <button onClick={onNewConversation} className="btn-new" aria-label={t("newConversation")}>
            <svg
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              style={{ width: "1rem", height: "1rem" }}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 4v16m8-8H4"
              />
            </svg>
          </button>

          {/* Overflow menu */}
          <div ref={overflowMenuRef} style={{ position: "relative" }}>
            <button
              onClick={() => setShowOverflowMenu(!showOverflowMenu)}
              className="btn-icon"
              aria-label={t("moreOptions")}
            >
              <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z"
                />
              </svg>
              {hasUpdate && <span className="version-update-dot" />}
            </button>

            {showOverflowMenu && (
              <div className="overflow-menu">
                {/* Diffs button - show when we have a CWD */}
                {(currentConversation?.cwd || selectedCwd) && (
                  <button
                    onClick={() => {
                      setShowOverflowMenu(false);
                      setShowDiffViewer(true);
                    }}
                    className="overflow-menu-item"
                  >
                    <svg
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                      style={{ width: "1.25rem", height: "1.25rem", marginRight: "0.75rem" }}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                      />
                    </svg>
                    {t("diffs")}
                  </button>
                )}
                {terminalURL && (
                  <button
                    onClick={() => {
                      setShowOverflowMenu(false);
                      const cwd = currentConversation?.cwd || selectedCwd || "";
                      const url = terminalURL.replace("WORKING_DIR", encodeURIComponent(cwd));
                      window.open(url, "_blank");
                    }}
                    className="overflow-menu-item"
                  >
                    <svg
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                      style={{ width: "1.25rem", height: "1.25rem", marginRight: "0.75rem" }}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
                      />
                    </svg>
                    {t("terminal")}
                  </button>
                )}
                {links.map((link, index) => (
                  <button
                    key={index}
                    onClick={() => {
                      setShowOverflowMenu(false);
                      window.open(link.url, "_blank");
                    }}
                    className="overflow-menu-item"
                  >
                    <svg
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                      style={{ width: "1.25rem", height: "1.25rem", marginRight: "0.75rem" }}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d={
                          link.icon_svg ||
                          "M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                        }
                      />
                    </svg>
                    {link.title}
                  </button>
                ))}

                {conversationId && onArchiveConversation && !currentConversation?.archived && (
                  <>
                    <div className="overflow-menu-divider" />
                    <button
                      onClick={async () => {
                        setShowOverflowMenu(false);
                        try {
                          await onArchiveConversation(conversationId);
                        } catch (err) {
                          console.error("Failed to archive conversation:", err);
                        }
                      }}
                      className="overflow-menu-item"
                    >
                      <svg
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                        style={{ width: "1.25rem", height: "1.25rem", marginRight: "0.75rem" }}
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M5 8h14M8 8V6a4 4 0 118 0v2m-9 0v10a2 2 0 002 2h6a2 2 0 002-2V8"
                        />
                      </svg>
                      {t("archiveConversation")}
                    </button>
                  </>
                )}

                {/* Version check */}
                <div className="overflow-menu-divider" />
                <button
                  onClick={() => {
                    setShowOverflowMenu(false);
                    openVersionModal();
                  }}
                  className="overflow-menu-item"
                >
                  <svg
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    style={{ width: "1.25rem", height: "1.25rem", marginRight: "0.75rem" }}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                    />
                  </svg>
                  {t("checkForNewVersion")}
                  {hasUpdate && <span className="version-menu-dot" />}
                </button>

                {/* Theme selector */}
                <div className="overflow-menu-divider" />
                <div className="theme-toggle-row">
                  <button
                    onClick={() => {
                      setThemeMode("system");
                      setStoredTheme("system");
                      applyTheme("system");
                    }}
                    className={`theme-toggle-btn${themeMode === "system" ? " theme-toggle-btn-selected" : ""}`}
                    title={t("system")}
                  >
                    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                      />
                    </svg>
                  </button>
                  <button
                    onClick={() => {
                      setThemeMode("light");
                      setStoredTheme("light");
                      applyTheme("light");
                    }}
                    className={`theme-toggle-btn${themeMode === "light" ? " theme-toggle-btn-selected" : ""}`}
                    title={t("light")}
                  >
                    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"
                      />
                    </svg>
                  </button>
                  <button
                    onClick={() => {
                      setThemeMode("dark");
                      setStoredTheme("dark");
                      applyTheme("dark");
                    }}
                    className={`theme-toggle-btn${themeMode === "dark" ? " theme-toggle-btn-selected" : ""}`}
                    title={t("dark")}
                  >
                    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"
                      />
                    </svg>
                  </button>
                </div>

                {/* Browser notifications toggle */}
                {typeof Notification !== "undefined" && (
                  <>
                    <div className="overflow-menu-divider" />
                    <div className="theme-toggle-row">
                      <button
                        onClick={async () => {
                          if (browserNotifsEnabled) return;
                          const granted = await requestBrowserNotificationPermission();
                          if (granted) {
                            setBrowserNotifsEnabled(true);
                          }
                        }}
                        className={`theme-toggle-btn${browserNotifsEnabled ? " theme-toggle-btn-selected" : ""}`}
                        title={
                          getBrowserNotificationState() === "denied"
                            ? t("blockedByBrowser")
                            : t("enableNotifications")
                        }
                        disabled={getBrowserNotificationState() === "denied"}
                      >
                        <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
                          />
                        </svg>
                      </button>
                      <button
                        onClick={() => {
                          if (!browserNotifsEnabled) return;
                          setChannelEnabled("browser", false);
                          setBrowserNotifsEnabled(false);
                        }}
                        className={`theme-toggle-btn${!browserNotifsEnabled ? " theme-toggle-btn-selected" : ""}`}
                        title={t("disableNotifications")}
                      >
                        <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M5.586 15H4l1.405-1.405A2.032 2.032 0 006 12.158V9a6.002 6.002 0 014-5.659V3a2 2 0 114 0v.341c.588.17 1.14.432 1.636.772M15 17h-6v1a3 3 0 006 0v-1zM18 9a3 3 0 00-3-3M3 3l18 18"
                          />
                        </svg>
                      </button>
                    </div>
                  </>
                )}

                {/* Markdown rendering toggle */}
                <div className="overflow-menu-divider" />
                <div className="md-toggle-row">
                  <div className="md-toggle-label">{t("markdown")}</div>
                  <div className="md-toggle-buttons">
                    <button
                      onClick={() => setMarkdownMode("off")}
                      className={`md-toggle-btn${markdownMode === "off" ? " md-toggle-btn-selected" : ""}`}
                      title={t("showPlainText")}
                    >
                      {t("off")}
                    </button>
                    <button
                      onClick={() => setMarkdownMode("agent")}
                      className={`md-toggle-btn${markdownMode === "agent" ? " md-toggle-btn-selected" : ""}`}
                      title={t("renderMarkdownAgent")}
                    >
                      {t("agent")}
                    </button>
                    <button
                      onClick={() => setMarkdownMode("all")}
                      className={`md-toggle-btn${markdownMode === "all" ? " md-toggle-btn-selected" : ""}`}
                      title={t("renderMarkdownAll")}
                    >
                      {t("all")}
                    </button>
                  </div>
                </div>

                {/* Language selector */}
                <div className="overflow-menu-divider" />
                <div className="language-selector-row">
                  <div className="md-toggle-label">
                    {t("language")}{" "}
                    <a
                      href={`https://github.com/boldsoftware/shelley/issues/new?labels=translation&title=${encodeURIComponent("Translation issue: ")}&body=${encodeURIComponent("**Language:** \n**Where in the UI:** \n**Current text:** \n**Suggested text:** \n")}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="report-bug-link"
                      onClick={(e) => e.stopPropagation()}
                    >
                      [{t("reportBug")}]
                    </a>
                  </div>
                  <LanguageDropdown locale={locale} setLocale={setLocale} t={t} />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Messages area */}
      {/* Messages area with scroll-to-bottom button wrapper */}
      <div className="messages-area-wrapper">
        <div className="messages-container scrollable" ref={messagesContainerRef}>
          {loading ? (
            showLoadingProgressUI ? (
              <div className="conversation-loading full-height">
                <div className="spinner"></div>
                <div className="conversation-loading-title">
                  {loadingProgress?.phase === "parsing"
                    ? "Rendering conversation…"
                    : "Loading conversation…"}
                </div>
                <div className="conversation-loading-subtitle">
                  {loadingProgress
                    ? loadingProgress.bytesTotal && loadingProgress.bytesTotal > 0
                      ? `${formatBytes(loadingProgress.bytesDownloaded)} of ${formatBytes(loadingProgress.bytesTotal)}`
                      : `${formatBytes(loadingProgress.bytesDownloaded)} downloaded`
                    : "Starting…"}
                  {lastKnownMessageCount !== null
                    ? ` • ~${lastKnownMessageCount} messages last time`
                    : ""}
                </div>
                <div className="conversation-loading-bar">
                  <div
                    className={`conversation-loading-bar-fill${
                      loadingProgress?.phase === "parsing"
                        ? " parsing"
                        : !loadingProgress?.bytesTotal || loadingProgress.bytesTotal <= 0
                          ? " indeterminate"
                          : ""
                    }`}
                    style={
                      loadingProgress?.phase === "parsing"
                        ? undefined
                        : loadingProgress?.bytesTotal && loadingProgress.bytesTotal > 0
                          ? {
                              width: `${Math.min(100, (loadingProgress.bytesDownloaded / loadingProgress.bytesTotal) * 100)}%`,
                            }
                          : undefined
                    }
                  />
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-center full-height">
                <div className="spinner"></div>
              </div>
            )
          ) : (
            <div className="messages-list">
              {renderMessages()}

              {/* Show streaming thinking as it comes in */}
              {streamingThinking && (
                <div className="message assistant-message streaming">
                  <div className="message-content">
                    <ThinkingContent thinking={streamingThinking} summary="Reasoning..." />
                  </div>
                </div>
              )}

              {/* Show streaming text as it comes in */}
              {streamingText && (
                <div className="message assistant-message streaming">
                  <div className="message-content">
                    {markdownMode !== "off" ? (
                      <MarkdownContent text={streamingText} />
                    ) : (
                      <div className="whitespace-pre-wrap break-words">{streamingText}</div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Scroll to bottom button - outside scrollable area */}
        {showScrollToBottom && (
          <button
            className="scroll-to-bottom-button"
            onClick={scrollToBottom}
            aria-label="Scroll to bottom"
          >
            <svg
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              style={{ width: "1.25rem", height: "1.25rem" }}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 14l-7 7m0 0l-7-7m7 7V3"
              />
            </svg>
          </button>
        )}
      </div>

      {/* Terminal Panel - between messages and status bar */}
      <TerminalPanel
        terminals={ephemeralTerminals}
        onClose={(id) => setEphemeralTerminals((prev) => prev.filter((t) => t.id !== id))}
        onInsertIntoInput={handleInsertFromTerminal}
        autoFocusId={terminalAutoFocusId}
        onAutoFocusConsumed={() => setTerminalAutoFocusId(null)}
        onActiveTerminalExited={() => {
          const input = document.querySelector<HTMLTextAreaElement>(
            '[data-testid="message-input"]',
          );
          input?.focus();
        }}
      />

      {/* Status bar — always visible on desktop; hidden on mobile for active convos
          (CSS hides it, and content is suppressed to avoid duplicate DOM elements). */}
      <div
        className={`status-bar${currentConversation?.archived ? " status-bar-archived" : ""}${!conversationId ? " status-bar-new" : ""}`}
      >
        <div className="status-bar-content">
          {(!isMobile || !conversationId || currentConversation?.archived) && renderStatusContent()}
        </div>
      </div>

      {/* Message input — hidden for archived conversations */}
      {!currentConversation?.archived && (
        <MessageInput
          key={conversationId || "new"}
          onSend={sendMessage}
          disabled={sending || loading}
          autoFocus={true}
          injectedText={terminalInjectedText || diffCommentText}
          onClearInjectedText={() => {
            setDiffCommentText("");
            setTerminalInjectedText(null);
          }}
          persistKey={conversationId || "new-conversation"}
          initialRows={conversationId ? 1 : 3}
          statusSlot={conversationId && isMobile ? renderStatusContent() : undefined}
        />
      )}

      {/* Directory Picker Modal */}
      <DirectoryPickerModal
        isOpen={showDirectoryPicker}
        onClose={() => setShowDirectoryPicker(false)}
        onSelect={(path) => {
          setSelectedCwd(path);
          setCwdError(null);
        }}
        initialPath={selectedCwd}
      />

      {/* Diff Viewer */}
      <DiffViewer
        cwd={diffViewerCwd || currentConversation?.cwd || selectedCwd}
        isOpen={showDiffViewer}
        onClose={() => {
          setShowDiffViewer(false);
          setDiffViewerInitialCommit(undefined);
          setDiffViewerCwd(undefined);
        }}
        onCommentTextChange={setDiffCommentText}
        initialCommit={diffViewerInitialCommit}
        onCwdChange={setDiffViewerCwd}
      />

      {/* Version Checker Modal */}
      {VersionModal}
    </div>
  );
}

export default ChatInterface;
