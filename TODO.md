# TODO: Codex CLI Backend

## Done ✅

1. **Slug generation race** — per-thread subscription channels (270beb3)
2. **Tool call visibility** — synthesize ContentTypeToolUse/Result blocks (270beb3)
3. **Process restart cleanup** — clear thread map on subprocess death (270beb3)
4. **Gateway visibility** — GatewayEnabled:true + LookPath check (270beb3)

## Next Up (High Priority)

### ~~5. Disable Codex's built-in tools~~ ✅ FIXED (627596d)
Set `sandbox: "read-only"` in thread/start. Disables Codex's built-in shell/file tools;
only Shelley's dynamic tools execute. Clean text responses, no duplicate execution.

### ~~6. Thread cleanup / eviction~~ ✅ FIXED (5168929)
Thread map capped at 100 entries; cleared entirely when limit is hit.

### ~~7. Codex model selection~~ ✅ FIXED (8a9b692)
Added "codex" provider to custom models UI. Users can create models with specific
Codex model names. Hides endpoint/API key fields (uses `codex login` auth).

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
