import React, { useEffect, useRef, useState } from "react";

interface ContextUsageBarProps {
  contextWindowSize: number;
  maxContextTokens: number;
  conversationId?: string | null;
  modelName?: string;
  onDistillConversation?: () => void;
  agentWorking?: boolean;
}

export default function ContextUsageBar({
  contextWindowSize,
  maxContextTokens,
  conversationId,
  modelName,
  onDistillConversation,
  agentWorking,
}: ContextUsageBarProps) {
  const [showPopup, setShowPopup] = useState(false);
  const [distilling, setDistilling] = useState(false);
  const [popupPosition, setPopupPosition] = useState<{ bottom: number; right: number } | null>(
    null,
  );
  const barRef = useRef<HTMLDivElement>(null);
  const hasAutoOpenedRef = useRef<string | null>(null);

  const percentage = maxContextTokens > 0 ? (contextWindowSize / maxContextTokens) * 100 : 0;
  const clampedPercentage = Math.min(percentage, 100);
  const showLongConversationWarning = contextWindowSize >= 100000;

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
  }, [agentWorking, conversationId, showLongConversationWarning]);

  useEffect(() => {
    if (!showPopup) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(event.target as Node)) {
        setShowPopup(false);
      }
    };
    document.addEventListener("click", handleClickOutside);
    return () => document.removeEventListener("click", handleClickOutside);
  }, [showPopup]);

  useEffect(() => {
    if (!showPopup || !barRef.current) {
      setPopupPosition(null);
      return;
    }
    const rect = barRef.current.getBoundingClientRect();
    setPopupPosition({
      bottom: window.innerHeight - rect.top + 4,
      right: window.innerWidth - rect.right,
    });
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
          onClick={() => setShowPopup(!showPopup)}
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
