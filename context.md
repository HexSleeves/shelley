# Codex CLI Backend for Shelley — Context

## What We Built

OpenAI Codex CLI (`codex app-server`) as an LLM backend for Shelley. Users sign in with ChatGPT/API account and use Codex models (e.g. `gpt-5.2-codex`) through Shelley's UI and tool ecosystem.

## Architecture

**Option A: Codex as LLM brain, Shelley runs tools.**

Shelley's tools are registered as Codex "dynamic tools". Codex drives its own tool loop — sends `item/tool/call` JSON-RPC requests, we execute via `tool.Run()`, return results. When the turn completes, `Do()` returns the final response with synthesized tool use/result content blocks.

- Tool calls happen *inside* `Do()`, not after it returns
- `Do()` always returns `StopReasonEndTurn` (tools already handled)
- Tool calls visible in UI via synthesized `ContentTypeToolUse` + `ContentTypeToolResult` blocks
- Codex maintains its own conversation state; `Do()` only sends latest user message text
- `sandbox: "read-only"` disables Codex's built-in shell/file tools; only Shelley's dynamic tools run

## Files

- **`llm/codex/codex.go`** — `Service` implementation (~530 lines)
- **`llm/codex/codex_test.go`** — Unit tests
- **`models/models.go`** — `ProviderCodex`, `codex-cli` model entry, custom model support
- **`ui/src/components/ModelsModal.tsx`** — "codex" provider type (no endpoint/API key fields)
- **`ui/src/services/api.ts`** — Provider type includes "codex"

## Codex App-Server Protocol (JSON-RPC over stdio)

1. `initialize` → response → `initialized` notification
2. `thread/start` (dynamicTools, approvalPolicy:"never", sandbox:"read-only", model, cwd, baseInstructions) → response with thread ID
3. `turn/start` (threadId, input text) → notifications stream:
   - `item/started`, `agentMessage/delta`, `item/completed`, `turn/completed`, `thread/tokenUsage/updated`
   - `item/tool/call` (server request — we execute and respond)

## Subprocess Model

- One `codex app-server` per `Service` (shared across conversations)
- Spawned lazily on first `Do()` with `exec.Command` (not CommandContext)
- **Per-thread subscription channels**: reader goroutine extracts `threadId` from params, routes to subscriber
- Pending RPC responses: `map[idStr]chan` for request-response correlation
- Thread map: `map[conversationID]codexThreadID` — cleared on process death, evicted at 100 entries
- `stdinMu` serializes writes

## Auth

- `codex login` (ChatGPT OAuth), stored in `~/.codex/`
- No API keys needed in Shelley's config
- Default model: `gpt-5.2-codex` with ChatGPT auth
- Custom models: users can add specific Codex models via UI (provider: "codex")

## Key Commits

```
8a9b692 llm/codex: support custom Codex models with specific model selection
5168929 llm/codex: evict thread map when it exceeds 100 entries
627596d llm/codex: use read-only sandbox to disable Codex built-in tools
270beb3 llm/codex: per-thread subscriptions, tool call visibility, process restart cleanup
bf37fc1 llm/codex: fix subprocess lifecycle and concurrent access
5da00c4 llm/codex: add Codex CLI app-server backend
f3267ed subagent: inherit model from parent conversation
```

## Building & Testing

```bash
make build                    # builds UI + binary
./bin/shelley -config /exe.dev/shelley.json -db /tmp/shelley-codex-test.db serve -port 8002
go test ./llm/codex/ ./models/ # unit tests (need ui/dist)
```

## Key Files to Read

- `llm/llm.go` — Service interface, Content/Response types
- `llm/codex/codex.go` — The Codex backend
- `loop/loop.go` — Agent loop
- `models/models.go` — Model registry + custom model creation
- `ui/src/components/ModelsModal.tsx` — Custom model UI
- `/tmp/codex-schema/v2/` — Full protocol JSON schemas
