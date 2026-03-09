CREATE TABLE job_runs (
    job_id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
    parent_job_id TEXT REFERENCES job_runs(job_id) ON DELETE SET NULL,
    kind TEXT NOT NULL CHECK (kind IN ('turn', 'subagent', 'distill')),
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'canceled', 'timed_out')),
    trigger_message_id TEXT REFERENCES messages(message_id) ON DELETE SET NULL,
    model_id TEXT,
    timeout_seconds INTEGER,
    input_json TEXT NOT NULL,
    output_json TEXT,
    error_json TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at DATETIME,
    finished_at DATETIME
);

CREATE INDEX idx_job_runs_conversation_created_at ON job_runs (conversation_id, created_at DESC);
CREATE INDEX idx_job_runs_status ON job_runs (status);

CREATE TABLE conversation_runtime (
    conversation_id TEXT PRIMARY KEY REFERENCES conversations(conversation_id) ON DELETE CASCADE,
    working BOOLEAN NOT NULL DEFAULT FALSE,
    active_job_id TEXT REFERENCES job_runs(job_id) ON DELETE SET NULL,
    last_event_id INTEGER NOT NULL DEFAULT 0,
    current_model_id TEXT,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE conversation_events (
    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
    job_id TEXT REFERENCES job_runs(job_id) ON DELETE SET NULL,
    message_id TEXT REFERENCES messages(message_id) ON DELETE SET NULL,
    stream_version INTEGER NOT NULL DEFAULT 1,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_conversation_events_conversation_event_id ON conversation_events (conversation_id, event_id ASC);

CREATE TABLE turn_metrics (
    job_id TEXT PRIMARY KEY REFERENCES job_runs(job_id) ON DELETE CASCADE,
    model_id TEXT,
    latency_ms INTEGER,
    first_token_latency_ms INTEGER,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
    cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens INTEGER NOT NULL DEFAULT 0,
    tool_call_count INTEGER NOT NULL DEFAULT 0,
    retry_count INTEGER NOT NULL DEFAULT 0,
    cancellation_reason TEXT,
    timeout_reason TEXT,
    cost_usd REAL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE subagent_metrics (
    job_id TEXT PRIMARY KEY REFERENCES job_runs(job_id) ON DELETE CASCADE,
    parent_conversation_id TEXT REFERENCES conversations(conversation_id) ON DELETE SET NULL,
    subagent_conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
    model_id TEXT,
    started_at DATETIME,
    finished_at DATETIME,
    outcome TEXT,
    timeout_seconds INTEGER,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    retry_count INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
