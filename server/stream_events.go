package server

import (
	"encoding/json"
	"fmt"
	"time"

	"shelley.exe.dev/db/generated"
)

const streamEventVersionV1 = 1

const (
	eventTypeHeartbeat           = "heartbeat"
	eventTypeStreamTextDelta     = "stream.text.delta"
	eventTypeStreamThinkingDelta = "stream.thinking.delta"
)

type StreamEventEnvelopeV1 struct {
	Version        int             `json:"version"`
	EventID        int64           `json:"event_id,omitempty"`
	ConversationID string          `json:"conversation_id"`
	JobID          *string         `json:"job_id,omitempty"`
	Type           string          `json:"type"`
	CreatedAt      time.Time       `json:"created_at"`
	Payload        json.RawMessage `json:"payload,omitempty"`
}

type streamJobPayload struct {
	Job generated.JobRun `json:"job"`
}

func marshalStreamPayload(payload any) (json.RawMessage, error) {
	if payload == nil {
		return nil, nil
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	return json.RawMessage(data), nil
}

func newTransientStreamEvent(conversationID string, jobID *string, eventType string, payload any) (StreamEventEnvelopeV1, error) {
	rawPayload, err := marshalStreamPayload(payload)
	if err != nil {
		return StreamEventEnvelopeV1{}, err
	}
	return StreamEventEnvelopeV1{
		Version:        streamEventVersionV1,
		ConversationID: conversationID,
		JobID:          jobID,
		Type:           eventType,
		CreatedAt:      time.Now(),
		Payload:        rawPayload,
	}, nil
}

func mustTransientStreamEvent(conversationID string, jobID *string, eventType string, payload any) StreamEventEnvelopeV1 {
	event, err := newTransientStreamEvent(conversationID, jobID, eventType, payload)
	if err != nil {
		panic(fmt.Errorf("failed to marshal stream payload: %w", err))
	}
	return event
}

func streamEventFromConversationEvent(event generated.ConversationEvent) StreamEventEnvelopeV1 {
	return StreamEventEnvelopeV1{
		Version:        int(event.StreamVersion),
		EventID:        event.EventID,
		ConversationID: event.ConversationID,
		JobID:          event.JobID,
		Type:           event.EventType,
		CreatedAt:      event.CreatedAt,
		Payload:        json.RawMessage(event.PayloadJson),
	}
}
