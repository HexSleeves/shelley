package server

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"shelley.exe.dev/llm"
)

func readStreamEventWithTimeout(t *testing.T, reader *bufio.Reader, timeout time.Duration) StreamEventEnvelopeV1 {
	t.Helper()

	type result struct {
		event StreamEventEnvelopeV1
		err   error
	}
	ch := make(chan result, 1)

	go func() {
		var dataLines []string
		for {
			line, err := reader.ReadString('\n')
			if err != nil {
				ch <- result{err: err}
				return
			}
			line = strings.TrimSpace(line)
			if line == "" && len(dataLines) > 0 {
				break
			}
			if strings.HasPrefix(line, "data: ") {
				dataLines = append(dataLines, strings.TrimPrefix(line, "data: "))
			}
		}

		var event StreamEventEnvelopeV1
		err := json.Unmarshal([]byte(strings.Join(dataLines, "\n")), &event)
		ch <- result{event: event, err: err}
	}()

	select {
	case res := <-ch:
		if res.err != nil {
			t.Fatalf("failed to read SSE event: %v", res.err)
		}
		return res.event
	case <-time.After(timeout):
		t.Fatal("timed out waiting for SSE event")
		return StreamEventEnvelopeV1{}
	}
}

func decodeStreamPayload(t *testing.T, event StreamEventEnvelopeV1) StreamResponse {
	t.Helper()
	var payload StreamResponse
	if len(event.Payload) == 0 {
		return payload
	}
	if err := json.Unmarshal(event.Payload, &payload); err != nil {
		t.Fatalf("failed to decode stream payload: %v", err)
	}
	return payload
}

// TestStreamResumeWithLastEventID verifies that last_event_id replays only newer
// persisted events and otherwise yields heartbeats.
func TestStreamResumeWithLastEventID(t *testing.T) {
	server, database, _ := newTestServer(t)

	ctx := context.Background()

	conv, err := database.CreateConversation(ctx, nil, true, nil, nil)
	if err != nil {
		t.Fatalf("failed to create conversation: %v", err)
	}

	if err := server.recordMessage(ctx, conv.ConversationID, llm.Message{
		Role:    llm.MessageRoleUser,
		Content: []llm.Content{{Type: llm.ContentTypeText, Text: "Hello"}},
	}, llm.Usage{}); err != nil {
		t.Fatalf("failed to record user message: %v", err)
	}

	if err := server.recordMessage(ctx, conv.ConversationID, llm.Message{
		Role:      llm.MessageRoleAssistant,
		Content:   []llm.Content{{Type: llm.ContentTypeText, Text: "Hi there!"}},
		EndOfTurn: true,
	}, llm.Usage{}); err != nil {
		t.Fatalf("failed to record agent message: %v", err)
	}

	mux := http.NewServeMux()
	server.RegisterRoutes(mux)
	httpServer := httptest.NewServer(mux)
	defer httpServer.Close()

	t.Run("initial snapshot", func(t *testing.T) {
		resp, err := http.Get(httpServer.URL + "/api/conversation/" + conv.ConversationID)
		if err != nil {
			t.Fatalf("failed to fetch conversation: %v", err)
		}
		defer resp.Body.Close()

		var snapshot StreamResponse
		if err := json.NewDecoder(resp.Body).Decode(&snapshot); err != nil {
			t.Fatalf("failed to decode snapshot: %v", err)
		}
		if len(snapshot.Messages) != 2 {
			t.Fatalf("expected 2 messages in snapshot, got %d", len(snapshot.Messages))
		}
		if snapshot.LastEventID == 0 {
			t.Fatal("expected snapshot to include last_event_id")
		}
	})

	t.Run("resume_no_new_events", func(t *testing.T) {
		resp, err := http.Get(httpServer.URL + "/api/conversation/" + conv.ConversationID)
		if err != nil {
			t.Fatalf("failed to fetch conversation: %v", err)
		}
		var snapshot StreamResponse
		if err := json.NewDecoder(resp.Body).Decode(&snapshot); err != nil {
			resp.Body.Close()
			t.Fatalf("failed to decode snapshot: %v", err)
		}
		resp.Body.Close()

		streamResp, err := http.Get(fmt.Sprintf("%s/api/conversation/%s/stream?last_event_id=%d", httpServer.URL, conv.ConversationID, snapshot.LastEventID))
		if err != nil {
			t.Fatalf("failed to open stream: %v", err)
		}
		defer streamResp.Body.Close()

		event := readStreamEventWithTimeout(t, bufio.NewReader(streamResp.Body), 2*time.Second)
		payload := decodeStreamPayload(t, event)
		if event.Type != eventTypeHeartbeat {
			t.Fatalf("expected heartbeat event, got %q", event.Type)
		}
		if !payload.Heartbeat {
			t.Fatal("expected heartbeat payload")
		}
		if len(payload.Messages) != 0 {
			t.Fatalf("expected 0 replayed messages, got %d", len(payload.Messages))
		}
	})

	t.Run("resume_with_missed_events", func(t *testing.T) {
		resp, err := http.Get(httpServer.URL + "/api/conversation/" + conv.ConversationID)
		if err != nil {
			t.Fatalf("failed to fetch conversation: %v", err)
		}
		var snapshot StreamResponse
		if err := json.NewDecoder(resp.Body).Decode(&snapshot); err != nil {
			resp.Body.Close()
			t.Fatalf("failed to decode snapshot: %v", err)
		}
		resp.Body.Close()

		usage := llm.Usage{InputTokens: 5000, OutputTokens: 200}
		if err := server.recordMessage(ctx, conv.ConversationID, llm.Message{
			Role:    llm.MessageRoleAssistant,
			Content: []llm.Content{{Type: llm.ContentTypeText, Text: "You missed this!"}},
		}, usage); err != nil {
			t.Fatalf("failed to record replayed message: %v", err)
		}

		streamResp, err := http.Get(fmt.Sprintf("%s/api/conversation/%s/stream?last_event_id=%d", httpServer.URL, conv.ConversationID, snapshot.LastEventID))
		if err != nil {
			t.Fatalf("failed to open stream: %v", err)
		}
		defer streamResp.Body.Close()

		event := readStreamEventWithTimeout(t, bufio.NewReader(streamResp.Body), 2*time.Second)
		payload := decodeStreamPayload(t, event)
		if event.Type != eventTypeMessageCreated {
			t.Fatalf("expected replayed message event, got %q", event.Type)
		}
		if payload.Heartbeat {
			t.Fatal("replayed event should not be a heartbeat")
		}
		if len(payload.Messages) != 1 {
			t.Fatalf("expected 1 replayed message, got %d", len(payload.Messages))
		}
		if payload.Messages[0].Type != "agent" {
			t.Fatalf("expected replayed agent message, got %q", payload.Messages[0].Type)
		}
		if payload.Messages[0].UsageData == nil {
			t.Fatal("expected replayed message to include usage data")
		}
		if payload.ContextWindowSize == 0 {
			t.Fatal("expected replayed agent message to include context_window_size")
		}
	})
}
