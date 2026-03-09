Shelley is an agentic loop with tool use. See
https://sketch.dev/blog/agent-loop for an example of the idea.

When Shelley starts via `go run ./cmd/shelley`, it opens the SQLite database,
starts the HTTP server, and serves the UI bundle from `ui/dist`. The entrypoint
in `cmd/shelley` is intentionally thin; most behavior lives under `server/`,
`loop/`, `claudetool/`, and `ui/`.

## Components

### ui/

Infrastructure:
  * React 18 + TypeScript
  * esbuild
  * pnpm
  * ESLint
  * lightweight `tsx` unit-style tests
  * Playwright end-to-end tests

### db/

The database is SQLite. We use `sqlc` for schema-driven query generation.

`conversation(conversation_id, slug, user_initiated, cwd, model, ...)`
  
  Represents a single conversation.

`message(conversation_id, message_id, type, llm_data, user_data, usage, display_data, ...)`

  Messages are visible in the UI and sent to the LLM as part of the 
  conversation. There may be both user-visible and llm-visible representations
  of messages.

Subagent conversations are stored as normal conversations with a
`parent_conversation_id`.

### server/

The server exposes the HTTP API, serves the embedded UI, and keeps active
conversation managers in memory. Conversation updates are streamed to the UI
over SSE.

Important routes include:

`/api/conversations`
  List conversations.

`/api/conversation/<id>`
  Return one conversation and its messages.

`/api/conversation/<id>/stream`
  SSE stream for incremental updates, heartbeats, and conversation state.

`/api/conversation/<id>/chat`
  Append a user message and start processing.

`/api/conversations/new`
  Create a conversation and send its first user message.

When a conversation becomes active, the server creates a `ConversationManager`
that owns the live `loop.Loop`, toolset, working directory, and SSE publisher
for that conversation.

## loop/

The agent loop turns persisted conversation history plus the current toolset
into LLM requests. It records tool calls, tool results, streamed text/thinking,
and assistant responses back into the database.

## claudetool/

The tool layer exposes shell execution, patch application, browser automation,
subagents, screenshots, and related utilities to the model.

## Other

Shelley talks to model providers through `llm/` and `models/`.
Logging uses `slog`.
