package codex

import (
	"testing"

	"shelley.exe.dev/llm"
)

func TestExtractLatestUserText(t *testing.T) {
	req := &llm.Request{
		Messages: []llm.Message{
			{Role: llm.MessageRoleUser, Content: []llm.Content{{Type: llm.ContentTypeText, Text: "first"}}},
			{Role: llm.MessageRoleAssistant, Content: []llm.Content{{Type: llm.ContentTypeText, Text: "reply"}}},
			{Role: llm.MessageRoleUser, Content: []llm.Content{{Type: llm.ContentTypeText, Text: "second"}}},
		},
	}

	got := extractLatestUserText(req)
	if got != "second" {
		t.Errorf("got %q, want %q", got, "second")
	}
}

func TestExtractLatestUserTextToolResult(t *testing.T) {
	// When the last user message is tool results only, skip it.
	req := &llm.Request{
		Messages: []llm.Message{
			{Role: llm.MessageRoleUser, Content: []llm.Content{{Type: llm.ContentTypeText, Text: "do something"}}},
			{Role: llm.MessageRoleAssistant, Content: []llm.Content{{Type: llm.ContentTypeToolUse, ToolName: "bash"}}},
			{Role: llm.MessageRoleUser, Content: []llm.Content{{Type: llm.ContentTypeToolResult, ToolUseID: "1"}}},
		},
	}

	got := extractLatestUserText(req)
	if got != "do something" {
		t.Errorf("got %q, want %q", got, "do something")
	}
}

func TestExtractLatestUserTextEmpty(t *testing.T) {
	req := &llm.Request{}
	got := extractLatestUserText(req)
	if got != "" {
		t.Errorf("got %q, want empty", got)
	}
}

func TestIDEquals(t *testing.T) {
	if !idEquals(int64(1), float64(1)) {
		t.Error("int64(1) should equal float64(1)")
	}
	if !idEquals("abc", "abc") {
		t.Error("string ids should match")
	}
	if idEquals(int64(1), int64(2)) {
		t.Error("1 should not equal 2")
	}
}

func TestServiceInterface(t *testing.T) {
	var _ llm.Service = (*Service)(nil)

	s := &Service{}
	if s.TokenContextWindow() == 0 {
		t.Error("TokenContextWindow should be nonzero")
	}
}
