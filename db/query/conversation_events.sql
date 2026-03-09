-- name: CreateConversationEvent :one
INSERT INTO conversation_events (
    conversation_id,
    job_id,
    message_id,
    stream_version,
    event_type,
    payload_json
)
VALUES (?, ?, ?, ?, ?, ?)
RETURNING *;

-- name: ListConversationEventsSince :many
SELECT * FROM conversation_events
WHERE conversation_id = ? AND event_id > ?
ORDER BY event_id ASC;
