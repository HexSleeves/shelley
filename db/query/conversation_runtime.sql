-- name: GetConversationRuntime :one
SELECT * FROM conversation_runtime
WHERE conversation_id = ?;

-- name: UpsertConversationRuntimeState :one
INSERT INTO conversation_runtime (
    conversation_id,
    working,
    active_job_id,
    last_event_id,
    current_model_id
)
VALUES (?, ?, ?, 0, ?)
ON CONFLICT(conversation_id) DO UPDATE SET
    working = excluded.working,
    active_job_id = excluded.active_job_id,
    current_model_id = excluded.current_model_id,
    updated_at = CURRENT_TIMESTAMP
RETURNING *;

-- name: UpsertConversationRuntimeEventCursor :one
INSERT INTO conversation_runtime (
    conversation_id,
    working,
    active_job_id,
    last_event_id,
    current_model_id
)
VALUES (?, FALSE, NULL, ?, NULL)
ON CONFLICT(conversation_id) DO UPDATE SET
    last_event_id = excluded.last_event_id,
    updated_at = CURRENT_TIMESTAMP
RETURNING *;
