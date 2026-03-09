package server

import (
	"context"
	"database/sql"
	"time"

	"shelley.exe.dev/db"
	"shelley.exe.dev/db/generated"
)

type RuntimeStateService struct {
	db *db.DB
}

func NewRuntimeStateService(database *db.DB) *RuntimeStateService {
	return &RuntimeStateService{db: database}
}

func (s *RuntimeStateService) Get(ctx context.Context, conversationID string, fallbackModel *string) (*generated.ConversationRuntime, error) {
	runtime, err := s.db.GetConversationRuntime(ctx, conversationID)
	if err == nil {
		return runtime, nil
	}
	if err == sql.ErrNoRows {
		return &generated.ConversationRuntime{
			ConversationID: conversationID,
			Working:        false,
			LastEventID:    0,
			CurrentModelID: fallbackModel,
			UpdatedAt:      time.Now(),
		}, nil
	}
	return nil, err
}

func upsertConversationRuntimeStateTx(ctx context.Context, q *generated.Queries, conversationID string, working bool, activeJobID, currentModelID *string) (generated.ConversationRuntime, error) {
	return q.UpsertConversationRuntimeState(ctx, generated.UpsertConversationRuntimeStateParams{
		ConversationID: conversationID,
		Working:        working,
		ActiveJobID:    activeJobID,
		CurrentModelID: currentModelID,
	})
}

func upsertConversationRuntimeCursorTx(ctx context.Context, q *generated.Queries, conversationID string, lastEventID int64) (generated.ConversationRuntime, error) {
	return q.UpsertConversationRuntimeEventCursor(ctx, generated.UpsertConversationRuntimeEventCursorParams{
		ConversationID: conversationID,
		LastEventID:    lastEventID,
	})
}
