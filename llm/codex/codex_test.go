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


func TestServiceInterface(t *testing.T) {
	var _ llm.Service = (*Service)(nil)

	s := &Service{}
	if s.TokenContextWindow() == 0 {
		t.Error("TokenContextWindow should be nonzero")
	}
}

func TestTurnErrorIsUnauthorized(t *testing.T) {
	tests := []struct {
		name string
		err  *turnError
		want bool
	}{
		{"nil", nil, false},
		{"string unauthorized", &turnError{Message: "auth failed", CodexErrorInfo: "unauthorized"}, true},
		{"message contains unauthorized", &turnError{Message: "Unauthorized request"}, true},
		{"other error", &turnError{Message: "rate limit exceeded", CodexErrorInfo: "usageLimitExceeded"}, false},
		{"empty", &turnError{Message: "something broke"}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.err.isUnauthorized(); got != tt.want {
				t.Errorf("isUnauthorized() = %v, want %v", got, tt.want)
			}
		})
	}
}
