package server

import (
	"context"
	"encoding/json"

	"shelley.exe.dev/db"
	"shelley.exe.dev/db/generated"
)

const streamEventVersion int64 = 1

const (
	eventTypeConversationUpdated      = "conversation.updated"
	eventTypeConversationStateChanged = "conversation.state.changed"
	eventTypeMessageCreated           = "message.created"
	eventTypeMessageUpdated           = "message.updated"
	eventTypeJobCreated               = "job.created"
	eventTypeJobUpdated               = "job.updated"
	eventTypeNotificationCreated      = "notification.created"
)

type EventLogService struct {
	db *db.DB
}

func NewEventLogService(database *db.DB) *EventLogService {
	return &EventLogService{db: database}
}

func marshalEventPayload(payload any) (string, error) {
	data, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

func appendConversationEventTx(ctx context.Context, q *generated.Queries, conversationID string, jobID, messageID *string, eventType string, payload any) (generated.ConversationEvent, error) {
	payloadJSON, err := marshalEventPayload(payload)
	if err != nil {
		return generated.ConversationEvent{}, err
	}

	event, err := q.CreateConversationEvent(ctx, generated.CreateConversationEventParams{
		ConversationID: conversationID,
		JobID:          jobID,
		MessageID:      messageID,
		StreamVersion:  streamEventVersion,
		EventType:      eventType,
		PayloadJson:    payloadJSON,
	})
	if err != nil {
		return generated.ConversationEvent{}, err
	}

	if _, err := upsertConversationRuntimeCursorTx(ctx, q, conversationID, event.EventID); err != nil {
		return generated.ConversationEvent{}, err
	}
	return event, nil
}

func (s *EventLogService) Append(ctx context.Context, conversationID string, jobID, messageID *string, eventType string, payload any) (*generated.ConversationEvent, error) {
	var event generated.ConversationEvent
	err := s.db.WithTx(ctx, func(q *generated.Queries) error {
		var err error
		event, err = appendConversationEventTx(ctx, q, conversationID, jobID, messageID, eventType, payload)
		return err
	})
	if err != nil {
		return nil, err
	}
	return &event, nil
}
