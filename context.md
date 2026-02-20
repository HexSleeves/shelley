# Codex CLI Backend for Shelley — Context Dump

## What We Did

Added support for using OpenAI's Codex CLI (`codex app-server`) as an LLM backend for Shelley, so users can sign in with their ChatGPT/API account and use Codex-powered models (like `gpt-5.2-codex`) through Shelley's UI and tool ecosystem.

## Architecture

### How Shelley Normally Works

1. **`llm.Service` interface** (`llm/llm.go`): `Do(ctx, *Request) (*Response, error)` — takes full conversation history + tools, returns one response
2. **`loop/loop.go`**: The agent loop. Calls `Do()`, gets response. If response has `StopReasonToolUse`, the loop executes tools and calls `Do()` again. If `StopReasonEndTurn`, the turn is done.
3. **`models/models.go`**: Registry of all models. Each has a `Factory` function that creates an `llm.Service`. The `Manager` creates services and provides them to the server.
4. **`server/`**: HTTP server + conversation management. Each conversation has a `ConversationManager` with a `Loop`.
5. **Tools** (`claudetool/`): bash, patch, keyword_search, browser, subagent, etc. Each is an `*llm.Tool` with a `Run` function.

### How the Codex Backend Works

**Key design decision: Option A — Codex as LLM, Shelley runs tools.**

Shelley's tools are registered as Codex "dynamic tools". Codex drives its own internal tool loop — when the model wants to call a tool, Codex sends an `item/tool/call` JSON-RPC request back to us, we execute the Shelley tool via `tool.Run()`, and return the result. Codex continues the turn. When the turn completes, `Do()` returns the final agent message text.

This means:
- Tool calls happen *inside* `Do()`, not after it returns
- `Do()` always returns `StopReasonEndTurn` (tools already handled)
- Shelley's loop sees a simple text response and records it
- Tool calls are NOT visible as separate UI elements (just the final response text)

### Files Changed

#### New Files
- **`llm/codex/codex.go`** — The `Service` implementation
- **`llm/codex/codex_test.go`** — Unit tests

#### Modified Files
- **`models/models.go`** — Added `ProviderCodex`, `codex-cli` model entry
- **`claudetool/subagent.go`** — Added `modelID` param to `SubagentRunner.RunSubagent` interface, `ModelID` field to `SubagentTool`
- **`claudetool/subagent_test.go`** — Updated mock signature
- **`claudetool/toolset.go`** — Wires `cfg.ModelID` into `SubagentTool`
- **`server/subagent.go`** — Accepts `modelID` from parent, falls back to `s.defaultModel` only if empty

### Codex App-Server Protocol

The protocol is **JSON-RPC over stdio** (newline-delimited JSON). The `codex app-server` subprocess reads from stdin and writes to stdout.

**Flow:**
1. Client → Server: `initialize` request (with clientInfo)
2. Server → Client: response with userAgent
3. Client → Server: `initialized` notification
4. Client → Server: `thread/start` request (with dynamicTools, approvalPolicy, sandbox, model, cwd, baseInstructions)
5. Server → Client: response with thread ID
6. Server → Client: `thread/started` notification
7. Client → Server: `turn/start` request (with threadId, input text)
8. Server → Client: various notifications (`item/started`, `agentMessage/delta`, `item/completed`, `turn/completed`, `thread/tokenUsage/updated`)
9. Server → Client: `item/tool/call` request (for dynamic tools) — client must respond
10. Server → Client: `turn/completed` notification (signals turn is done)

**Server requests we handle:**
- `item/tool/call` — Execute a Shelley tool, respond with `{output, success}`
- `item/commandExecution/requestApproval` — Auto-approve with `{decision: "accept"}`
- `item/fileChange/requestApproval` — Auto-approve with `{decision: "accept"}`

**Full protocol schemas** were generated to `/tmp/codex-schema/` and `/tmp/codex-schema/v2/` via:
```
codex app-server generate-json-schema --out /tmp/codex-schema
```

### Subprocess Management

- One `codex app-server` process per `Service` instance (shared across all conversations)
- Process is spawned lazily on first `Do()` call with `exec.Command` (NOT `exec.CommandContext` — the process must outlive request contexts)
- Reader goroutine reads stdout, routes responses to pending callers via a `map[string]chan`, broadcasts notifications via a shared channel
- Multiple concurrent `Do()` calls are safe (e.g. slug generation + main conversation)
- Thread state: `map[conversationID]codexThreadID` — one Codex thread per Shelley conversation
- Since Codex maintains its own conversation state, `Do()` only sends the latest user message text (not the full history)

### Authentication

- Codex uses its own auth (`codex login`), stored in `~/.codex/`
- Currently logged in via ChatGPT OAuth (device flow redirect)
- No API keys needed in Shelley's config
- Login status: `codex login status`
- The OAuth redirect goes to `localhost:PORT/auth/callback` — on a remote VM, you need to `curl` the callback URL on the VM itself

### Current State

- **Working**: Basic message send/receive through UI, dynamic tool execution, token usage reporting
- **Test instance**: Running on port 8002 (`tmux session: shelley-test`), DB at `/tmp/shelley-codex-test3.db`
- **Default model**: `gpt-5.2-codex` (Codex's default when using ChatGPT auth)
- **Model restrictions**: Some models (e.g. `o3`) are not available with ChatGPT auth, only with API keys

### Git Log

```
bf37fc1 llm/codex: fix subprocess lifecycle and concurrent access
5da00c4 llm/codex: add Codex CLI app-server backend
f3267ed subagent: inherit model from parent conversation
```

All changes are on the `main` branch of `/home/exedev/shelley/`.

## Key Code Paths

### How a message flows through Codex backend

1. User sends message via UI → `server/handlers.go` `handleChat` → `ConversationManager.AcceptUserMessage`
2. `ConversationManager.ensureLoop` creates a `loop.Loop` with the codex `llm.Service`
3. `loop.Go` → `processLLMRequest` → `llmService.Do(ctx, req)`
4. `codex.Service.Do`:
   a. `ensureProcess` — spawns `codex app-server` if needed, runs `initialize`
   b. `getOrCreateThread` — creates Codex thread with dynamic tools + system prompt
   c. Sends `turn/start` with user text
   d. Drains broadcast channel: handles `item/tool/call` (executes Shelley tools), collects `item/completed` (agent messages), waits for `turn/completed`
   e. Returns `llm.Response` with collected text, thinking, usage
5. Loop records the response, turn ends

### Building and Testing

```bash
# Build UI
cd ui && pnpm install && pnpm run build

# Build binary (needs dummy template)
touch templates/dummy.tar.gz
go build -o bin/shelley-test ./cmd/shelley

# Run test instance
./bin/shelley-test -db /tmp/shelley-test.db serve -port 8002

# Run unit tests (need dummy ui/dist)
mkdir -p ui/dist && echo '{}' > ui/dist/build-info.json && echo '<html></html>' > ui/dist/index.html
go test ./llm/codex/ ./models/ ./claudetool/ ./loop/ -count=1
```

### Important Files to Read

- `llm/llm.go` — The `Service` interface and all shared types
- `llm/codex/codex.go` — The Codex backend (our main new code)
- `loop/loop.go` — The agent loop
- `models/models.go` — Model registry and manager
- `server/convo.go` — Conversation manager
- `server/subagent.go` — Subagent runner
- `claudetool/toolset.go` — Tool registration
- `/tmp/codex-schema/` — Full Codex protocol JSON schemas
