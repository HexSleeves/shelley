import React from "react";
import type { LLMContent } from "../types";
import BashTool from "./BashTool";
import BrowserAccessibilityTool from "./BrowserAccessibilityTool";
import BrowserConsoleLogsTool from "./BrowserConsoleLogsTool";
import BrowserEmulateTool from "./BrowserEmulateTool";
import BrowserEvalTool from "./BrowserEvalTool";
import BrowserNavigateTool from "./BrowserNavigateTool";
import BrowserNetworkTool from "./BrowserNetworkTool";
import BrowserProfileTool from "./BrowserProfileTool";
import BrowserResizeTool from "./BrowserResizeTool";
import BrowserTool from "./BrowserTool";
import ChangeDirTool from "./ChangeDirTool";
import GenericTool from "./GenericTool";
import KeywordSearchTool from "./KeywordSearchTool";
import LLMOneShotTool from "./LLMOneShotTool";
import OutputIframeTool from "./OutputIframeTool";
import PatchTool from "./PatchTool";
import ReadImageTool from "./ReadImageTool";
import ScreenshotTool from "./ScreenshotTool";
import SubagentTool from "./SubagentTool";

// IMPORTANT: When adding a new tool here, also update BrowserTool.tsx if it is
// a browser action and loop/predictable.go if it appears in the demo response.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const TOOL_COMPONENTS: Record<string, React.ComponentType<any>> = {
  bash: BashTool,
  patch: PatchTool,
  browser: BrowserTool,
  screenshot: ScreenshotTool,
  read_image: ReadImageTool,
  keyword_search: KeywordSearchTool,
  change_dir: ChangeDirTool,
  subagent: SubagentTool,
  output_iframe: OutputIframeTool,
  llm_one_shot: LLMOneShotTool,
  browser_emulate: BrowserEmulateTool,
  browser_network: BrowserNetworkTool,
  browser_accessibility: BrowserAccessibilityTool,
  browser_profile: BrowserProfileTool,
  browser_take_screenshot: ScreenshotTool,
  browser_navigate: BrowserNavigateTool,
  browser_eval: BrowserEvalTool,
  browser_resize: BrowserResizeTool,
  browser_recent_console_logs: BrowserConsoleLogsTool,
  browser_clear_console_logs: BrowserConsoleLogsTool,
};

export interface ToolRenderOptions {
  toolName?: string;
  toolInput?: unknown;
  isRunning: boolean;
  toolResult?: LLMContent[];
  hasError?: boolean;
  executionTime?: string;
  display?: unknown;
  onCommentTextChange?: (text: string) => void;
  fallback?: "generic" | "none";
}

export function formatExecutionTime(
  startTime?: string | null,
  endTime?: string | null,
): string {
  if (!startTime || !endTime) {
    return "";
  }
  const start = new Date(startTime).getTime();
  const end = new Date(endTime).getTime();
  const diffMs = end - start;
  if (diffMs < 1000) {
    return `${diffMs}ms`;
  }
  return `${(diffMs / 1000).toFixed(1)}s`;
}

export function renderToolCall({
  toolName,
  toolInput,
  isRunning,
  toolResult,
  hasError,
  executionTime,
  display,
  onCommentTextChange,
  fallback = "generic",
}: ToolRenderOptions): React.ReactNode {
  const resolvedToolName = toolName || "Unknown Tool";
  const ToolComponent = TOOL_COMPONENTS[resolvedToolName];

  if (!ToolComponent) {
    if (fallback === "none") {
      return null;
    }
    return (
      <GenericTool
        toolName={resolvedToolName}
        toolInput={toolInput}
        isRunning={isRunning}
        toolResult={toolResult}
        hasError={hasError}
        executionTime={executionTime}
      />
    );
  }

  const baseProps = {
    toolInput,
    isRunning,
    toolResult,
    hasError,
    executionTime,
  };

  switch (resolvedToolName) {
    case "patch":
      return (
        <PatchTool
          {...baseProps}
          display={display}
          onCommentTextChange={onCommentTextChange}
        />
      );
    case "subagent":
      return (
        <SubagentTool
          {...baseProps}
          displayData={display as { slug?: string; conversation_id?: string } | undefined}
        />
      );
    case "browser":
    case "screenshot":
    case "browser_take_screenshot":
    case "output_iframe":
      return <ToolComponent {...baseProps} display={display} />;
    case "browser_recent_console_logs":
    case "browser_clear_console_logs":
      return <BrowserConsoleLogsTool {...baseProps} toolName={resolvedToolName} />;
    default:
      return <ToolComponent {...baseProps} />;
  }
}
