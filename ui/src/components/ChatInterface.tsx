import React, { useState, useEffect, useCallback } from "react";
import {
  Conversation,
  ConversationState,
  LLMContent,
  ConversationListUpdate,
  isDistillStatusMessage,
} from "../types";
import { api } from "../services/api";
import { setFaviconStatus } from "../services/favicon";
import { ThemeMode, getStoredTheme } from "../services/theme";
import { useMarkdown } from "../contexts/MarkdownContext";
import { useI18n } from "../i18n";
import { isChannelEnabled } from "../services/notifications";
import MessageComponent from "./Message";
import MessageInput from "./MessageInput";
import DiffViewer from "./DiffViewer";
import DirectoryPickerModal from "./DirectoryPickerModal";
import { useVersionChecker } from "./VersionChecker";
import ThinkingContent from "./ThinkingContent";
import MarkdownContent from "./MarkdownContent";
import TerminalPanel, { EphemeralTerminal } from "./TerminalPanel";
import SystemPromptView from "./SystemPromptView";
import { renderToolCall, formatExecutionTime } from "./toolRendering";
import { useComposerPreferences } from "../hooks/useComposerPreferences";
import { useConversationActions } from "../hooks/useConversationActions";
import { useConversationSnapshot } from "../hooks/useConversationSnapshot";
import { useConversationStream } from "../hooks/useConversationStream";
import { useMessageScroll } from "../hooks/useMessageScroll";
import { useCoalescedMessages } from "../hooks/useCoalescedMessages";
import ChatStatusContent from "./ChatStatusContent";
import ChatOverflowMenu from "./ChatOverflowMenu";

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
    onSelectedModelChange: setSelectedModel,
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
    onSelectedModelChange: setSelectedModel,
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
  const { messagesContainerRef, showScrollToBottom, scrollToBottom } = useMessageScroll({
    conversationId,
    messages,
    loading,
    navigateUserMessageTrigger,
    pauseAutoScroll,
  });
  const [showDirectoryPicker, setShowDirectoryPicker] = useState(false);
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

  const handleOpenDiffViewer = useCallback((commit: string, cwd?: string) => {
    setDiffViewerInitialCommit(commit);
    setDiffViewerCwd(cwd);
    setShowDiffViewer(true);
  }, []);

  const sendMessage = async (message: string) => {
    const trimmedMessage = message.trim();
    if (!trimmedMessage) return;

    if (trimmedMessage.startsWith("!")) {
      const shellCommand = trimmedMessage.slice(1).trim();
      if (!shellCommand) return;

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
      requestAnimationFrame(scrollToBottom);
      return;
    }

    await sendConversationMessage(trimmedMessage);
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

  const coalescedItems = useCoalescedMessages(messages);

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

  const statusContent = (
    <ChatStatusContent
      currentConversation={currentConversation}
      conversationId={conversationId}
      hostname={hostname}
      error={error}
      setError={setError}
      isDisconnected={isDisconnected}
      isReconnecting={isReconnecting}
      reconnectAttempts={reconnectAttempts}
      reconnect={reconnect}
      agentWorking={agentWorking}
      cancelling={cancelling}
      onCancel={handleCancel}
      contextWindowSize={contextWindowSize}
      models={models}
      selectedModel={selectedModel}
      selectedModelDisplayName={selectedModelDisplayName}
      selectedCwd={selectedCwd}
      cwdError={cwdError}
      sending={sending}
      onSelectModel={setSelectedModel}
      onManageModels={() => onOpenModelsModal?.()}
      onOpenDirectoryPicker={() => setShowDirectoryPicker(true)}
      onDistillConversation={onDistillConversation ? handleDistillConversation : undefined}
      onUnarchive={handleUnarchive}
      t={t}
    />
  );

  return (
    <div className="full-height flex flex-col">
      {/* Header */}
      <div className="header">
        <div className="header-left">
          <button
            onClick={onOpenDrawer}
            className="btn-icon header-menu-button hide-on-desktop"
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

          <ChatOverflowMenu
            hasUpdate={hasUpdate}
            conversationId={conversationId}
            currentConversation={currentConversation}
            selectedCwd={selectedCwd}
            terminalURL={terminalURL}
            links={links}
            themeMode={themeMode}
            markdownMode={markdownMode}
            locale={locale}
            browserNotifsEnabled={browserNotifsEnabled}
            setBrowserNotifsEnabled={setBrowserNotifsEnabled}
            setThemeMode={setThemeMode}
            setMarkdownMode={setMarkdownMode}
            setLocale={setLocale}
            onOpenVersionModal={openVersionModal}
            onOpenDiffViewer={() => setShowDiffViewer(true)}
            onArchiveConversation={onArchiveConversation}
            t={t}
          />
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
          {(!isMobile || !conversationId || currentConversation?.archived) && statusContent}
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
          statusSlot={conversationId && isMobile ? statusContent : undefined}
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
