import React, { useEffect, useState } from "react";
import { Conversation } from "../types";
import { type TranslationKeys } from "../i18n";
import ContextUsageBar from "./ContextUsageBar";
import ModelPicker from "./ModelPicker";

function AnimatedWorkingStatus() {
  const text = "Agent working...";
  const [boldIndex, setBoldIndex] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setBoldIndex((prev) => (prev + 1) % text.length);
    }, 100);
    return () => clearInterval(interval);
  }, [text.length]);

  return (
    <span className="status-message animated-working">
      {text.split("").map((char, index) => (
        <span key={index} className={index === boldIndex ? "bold-letter" : ""}>
          {char}
        </span>
      ))}
    </span>
  );
}

interface ChatStatusContentProps {
  currentConversation?: Conversation;
  conversationId: string | null;
  hostname: string;
  error: string | null;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  isDisconnected: boolean;
  isReconnecting: boolean;
  reconnectAttempts: number;
  reconnect: () => void;
  agentWorking: boolean;
  cancelling: boolean;
  onCancel: () => void;
  contextWindowSize: number;
  models: Array<{
    id: string;
    display_name?: string;
    max_context_tokens?: number;
    ready: boolean;
    source?: string;
  }>;
  selectedModel: string;
  selectedModelDisplayName: string;
  selectedCwd: string;
  cwdError: string | null;
  sending: boolean;
  onSelectModel: (model: string) => void;
  onManageModels?: () => void;
  onOpenDirectoryPicker: () => void;
  onDistillConversation?: () => void;
  onUnarchive: () => void;
  t: (key: keyof TranslationKeys) => string;
}

export default function ChatStatusContent({
  currentConversation,
  conversationId,
  hostname,
  error,
  setError,
  isDisconnected,
  isReconnecting,
  reconnectAttempts,
  reconnect,
  agentWorking,
  cancelling,
  onCancel,
  contextWindowSize,
  models,
  selectedModel,
  selectedModelDisplayName,
  selectedCwd,
  cwdError,
  sending,
  onSelectModel,
  onManageModels,
  onOpenDirectoryPicker,
  onDistillConversation,
  onUnarchive,
  t,
}: ChatStatusContentProps) {
  if (currentConversation?.archived) {
    return (
      <>
        <span className="status-message">This conversation is archived.</span>
        <button onClick={onUnarchive} className="status-button status-button-primary">
          Unarchive
        </button>
      </>
    );
  }

  if (isDisconnected) {
    return (
      <>
        <span className="status-message status-warning">Disconnected</span>
        <button onClick={reconnect} className="status-button status-button-primary">
          Retry
        </button>
      </>
    );
  }

  if (isReconnecting) {
    return (
      <span className="status-message status-reconnecting">
        Reconnecting{reconnectAttempts > 0 ? ` (${reconnectAttempts}/3)` : ""}
        <span className="reconnecting-dots">...</span>
      </span>
    );
  }

  if (error) {
    return (
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
    );
  }

  if (agentWorking && conversationId) {
    return (
      <div className="status-bar-active" data-testid="agent-thinking">
        <div className="status-working-group">
          <AnimatedWorkingStatus />
          <button
            onClick={onCancel}
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
          maxContextTokens={models.find((model) => model.id === selectedModel)?.max_context_tokens || 200000}
          conversationId={conversationId}
          modelName={selectedModelDisplayName}
          onDistillConversation={onDistillConversation}
          agentWorking={agentWorking}
        />
      </div>
    );
  }

  if (!conversationId) {
    return (
      <div className="status-bar-new-conversation">
        <div className="status-field status-field-model" title="AI model to use for this conversation">
          <span className="status-field-label">{t("modelLabel")}</span>
          <ModelPicker
            models={models}
            selectedModel={selectedModel}
            onSelectModel={onSelectModel}
            onManageModels={onManageModels || (() => {})}
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
            onClick={onOpenDirectoryPicker}
            disabled={sending}
          >
            {selectedCwd || "(no cwd)"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="status-bar-active">
      <span className="status-message status-ready">
        <span className="hide-on-mobile">Ready on </span>
        {hostname}
      </span>
      <ContextUsageBar
        contextWindowSize={contextWindowSize}
        maxContextTokens={models.find((model) => model.id === selectedModel)?.max_context_tokens || 200000}
        conversationId={conversationId}
        modelName={selectedModelDisplayName}
        onDistillConversation={onDistillConversation}
        agentWorking={agentWorking}
      />
    </div>
  );
}
