package server

import (
	"context"
	"errors"
	"testing"

	"shelley.exe.dev/db"
	"shelley.exe.dev/llm"
)

func TestAcceptUserMessageFailsWhenImmediatePersistenceFails(t *testing.T) {
	h := NewTestHarness(t)
	ctx := context.Background()

	conversation, err := h.db.CreateConversation(ctx, nil, true, nil, nil)
	if err != nil {
		t.Fatalf("failed to create conversation: %v", err)
	}

	recordErr := errors.New("boom")
	manager := NewConversationManager(
		conversation.ConversationID,
		h.db,
		h.server.logger,
		h.server.toolSetConfig,
		func(context.Context, llm.Message, llm.Usage) error { return recordErr },
		nil,
	)
	t.Cleanup(func() {
		if manager.loopCancel != nil {
			manager.loopCancel()
		}
		if manager.toolSet != nil {
			manager.toolSet.Cleanup()
		}
	})

	_, err = manager.AcceptUserMessage(ctx, h.llm, "predictable", llm.Message{
		Role:    llm.MessageRoleUser,
		Content: []llm.Content{{Type: llm.ContentTypeText, Text: "hello"}},
	})
	if !errors.Is(err, recordErr) {
		t.Fatalf("expected record error, got %v", err)
	}

	messages, err := h.db.ListMessages(ctx, conversation.ConversationID)
	if err != nil {
		t.Fatalf("failed to list messages: %v", err)
	}
	for _, msg := range messages {
		if msg.Type == string(db.MessageTypeUser) {
			t.Fatalf("unexpected persisted user message: %+v", msg)
		}
	}
	if manager.IsAgentWorking() {
		t.Fatal("agent should not be marked working when persistence fails")
	}
}
