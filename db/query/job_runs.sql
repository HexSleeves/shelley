-- name: CreateJobRun :one
INSERT INTO job_runs (
    job_id,
    conversation_id,
    parent_job_id,
    kind,
    status,
    trigger_message_id,
    model_id,
    timeout_seconds,
    input_json,
    output_json,
    error_json,
    attempt_count,
    started_at,
    finished_at
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
RETURNING *;

-- name: GetJobRun :one
SELECT * FROM job_runs
WHERE job_id = ?;

-- name: ListJobRunsForConversation :many
SELECT * FROM job_runs
WHERE conversation_id = ?
ORDER BY created_at DESC
LIMIT ?;

-- name: ListIncompleteJobRuns :many
SELECT * FROM job_runs
WHERE status IN ('queued', 'running')
ORDER BY created_at ASC;

-- name: UpdateJobRunLifecycle :one
UPDATE job_runs
SET
    status = ?,
    model_id = COALESCE(?, model_id),
    output_json = ?,
    error_json = ?,
    attempt_count = ?,
    started_at = COALESCE(started_at, ?),
    finished_at = ?
WHERE job_id = ?
RETURNING *;
