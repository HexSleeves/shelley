# TODO: Codex CLI Backend

## Done ✅

1. **Slug generation race** — per-thread subscription channels (270beb3)
2. **Tool call visibility** — synthesize ContentTypeToolUse/Result blocks (270beb3)
3. **Process restart cleanup** — clear thread map on subprocess death (270beb3)
4. **Gateway visibility** — GatewayEnabled:true + LookPath check (270beb3)

## Next Up (High Priority)

### 5. Disable Codex's built-in tools
Codex has its own shell/file tools AND we register Shelley's tools as dynamic tools. Both execute simultaneously — Codex runs `ls` via its builtin, AND calls our `bash` tool. This causes duplicate work and confusing output (model's text contains raw command output mixed with the tool result).

**Options:**
- Set `sandbox: "none"` or `sandbox: "locked-down"` in thread/start to disable Codex's builtins. Then only Shelley's dynamic tools run. Need to test if the protocol supports this.
- If no protocol support, set `approvalPolicy: "on-failure"` or similar to block builtins.
- Worst case: accept overlap but filter duplicate content from the response.

### 6. Thread cleanup / eviction
The `threads` map grows unboundedly. Add cleanup when conversations are deleted/archived, or cap with an LRU.

### 7. Codex model selection
Only `codex-cli` model registered (uses Codex's default). Users may want to pick specific models. Options:
- Query `model/list` JSON-RPC after initialization
- Pass user-selected model to `thread/start`
- Register multiple model entries or use custom model UI

## Medium Priority

### 8. Streaming / incremental display
No streaming at any layer — not Codex-specific. `llm.Service.Do()` is synchronous. Codex sends `agentMessage/delta` notifications we ignore. Adding streaming requires:
- New interface (callback/channel for partial results)
- Loop changes to forward deltas
- SSE protocol changes (currently streams whole messages, not tokens)
- UI renderer for incremental text
This is a cross-cutting concern affecting all backends.

### 9. Context window / token tracking
`TokenContextWindow()` returns hardcoded 200k. Should query from Codex's `model/list` or thread/start response.

### 10. Test coverage
Only basic unit tests. Need:
- Mock `codex app-server` (small Go program speaking the protocol)
- Test concurrent `Do()` calls on different threads
- Test process crash/restart cycle
- Test dynamic tool call round-trip

## Low Priority

### 11. Codex login flow in UI
UI button to trigger `codex login` via `v2/LoginAccountParams` JSON-RPC.

### 12. Reasoning display
Codex `reasoning` items have `summary` arrays. Currently concatenated into one thinking block. Could be richer.

### 13. Approval forwarding to UI
Forward command/file approvals to Shelley's UI for user confirmation. Requires pause-turn mechanism + approval dialog components.

## Architecture Notes

- Per-thread subscription channels handle concurrent multi-conversation access.
- Codex's app-server protocol is experimental and may change.
- Protocol schemas at `/tmp/codex-schema/` (regenerate with `codex app-server generate-json-schema --out`).
- The `codex.Service` mutex is only for process lifecycle + thread map; turn execution is lock-free.
