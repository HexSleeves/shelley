# TODO: Codex CLI Backend

## Bugs (High Priority)

### 1. Slug generation race condition
The slug generation fires a concurrent `Do()` call on the same `codex.Service`. Both the main turn and the slug generation read from the same `broadcast` channel. The slug call can steal notifications meant for the main turn (and vice versa). This causes:
- Slug gets "(no response)" because it sees an empty turn
- Main turn might miss its own `turn/completed` if slug steals it

**Fix options:**
- (a) Filter broadcast messages by `threadId` — each `Do()` only processes notifications for its own thread. This is the correct fix. Add `threadID` to the handler closure's filter and re-queue messages for other threads.
- (b) Use per-thread subscription channels instead of a single broadcast channel. Reader goroutine maintains a `map[threadID]chan`. More complex but cleanest.
- (c) Skip slug generation entirely for the codex provider (cheapest fix, loses feature).

### 2. Tool call visibility in UI
Tool calls happen inside `Do()` and are invisible to Shelley's loop/UI. The user only sees the final text response. This is a design tradeoff, not a bug per se, but it degrades the UX.

**Fix options:**
- Synthesize `llm.Content` blocks for each tool call that happened during the turn. When we get `item/completed` with `type: commandExecution` or `type: fileChange` or dynamic tool calls, build corresponding `ContentTypeToolUse` + `ContentTypeToolResult` content blocks and include them in the response. The loop will see `StopReasonEndTurn` (not `StopReasonToolUse`) so it won't re-execute them, but the UI will display them.
- This requires careful construction of the content array to match what Shelley's UI expects.

## Improvements (Medium Priority)

### 3. Thread cleanup
Codex threads are never cleaned up. The `threads` map grows unboundedly. Add eviction when conversations are deleted/archived, or use an LRU.

### 4. Process restart on crash
If the `codex app-server` process dies mid-turn, the error propagates correctly, but the thread map becomes stale (thread IDs from the dead process are invalid). On restart, the `threads` map should be cleared so new threads are created.

Currently `ensureProcess` detects a dead process via `p.done` and sets `s.proc = nil`, but doesn't clear `s.threads`. Add:
```go
if s.proc != nil {
    select {
    case <-s.proc.done:
        s.proc = nil
        s.threads = nil // clear stale thread IDs
    default:
        return nil
    }
}
```

### 5. Codex model selection
Currently only one `codex-cli` model is registered. Users might want to pick specific Codex models (e.g. `gpt-5.2-codex`, `gpt-5.3-codex`). Options:
- Query available models via `model/list` JSON-RPC call after initialization
- Register multiple model entries that pass different `Model` values to the `codex.Service`
- Let users configure the model via the custom models UI

### 6. Streaming / incremental display
Codex sends `agentMessage/delta` notifications with incremental text. Currently we ignore these and only use `item/completed`. To show streaming text in the UI, we'd need to:
- Forward deltas to Shelley's SSE stream somehow
- This requires changes to the `llm.Service` interface (currently synchronous) or a side-channel

### 7. Approval forwarding to UI
Currently we auto-approve all command executions and file changes. For safety, these could be forwarded to Shelley's UI for user confirmation. This would require:
- A new server-side mechanism to pause a turn and ask for user input
- UI components for approval dialogs
- This is a bigger architectural change

### 8. Context window / token tracking
`TokenContextWindow()` returns a hardcoded 200k. Should query from Codex's `thread/start` response which includes the model info, or from `model/list`.

## Nice to Have (Low Priority)

### 9. Codex login flow in Shelley UI
Add a UI button/flow to trigger `codex login` from within Shelley, rather than requiring CLI access. Could use the `v2/LoginAccountParams` JSON-RPC method.

### 10. Reasoning display
Codex sends `reasoning` items with `summary` arrays. These are currently concatenated into a single `ContentTypeThinking` block. Could be displayed more richly.

### 11. Codex's built-in tools alongside Shelley's
Currently we register only Shelley's tools as dynamic tools and set `sandbox: danger-full-access`. Codex also has its own built-in tools (shell exec, file editing). These coexist but could conflict. Consider:
- Disabling Codex's built-in tools if possible (no known protocol support for this)
- Or embracing both and handling the overlap

### 12. Test coverage
Only basic unit tests exist. Need:
- Integration test with a mock `codex app-server` (a small Go program that speaks the protocol)
- Test concurrent `Do()` calls
- Test process crash/restart
- Test dynamic tool call flow

## Architecture Notes for Future Work

- The `broadcast` channel is a bottleneck — only one goroutine can read each message. For true concurrent multi-conversation support, switch to per-thread channels (see bug #1).
- The `codex.Service` holds a mutex but most operations don't need it after process startup. The current locking is minimal (only for process lifecycle and thread map).
- Codex's app-server protocol is experimental (`[experimental]` in help text). It may change.
- The protocol schemas are at `/tmp/codex-schema/` (generated via `codex app-server generate-json-schema --out /tmp/codex-schema`). Regenerate if Codex updates.
