# TODO: Codex CLI Backend

## Done ✅

1. **Slug generation race** — per-thread subscription channels (270beb3)
2. **Tool call visibility** — synthesize ContentTypeToolUse/Result blocks (270beb3)
3. **Process restart cleanup** — clear thread map on subprocess death (270beb3)
4. **Gateway visibility** — GatewayEnabled:true + LookPath check (270beb3)
5. **Disable Codex builtins** — `sandbox: "read-only"` (627596d)
6. **Thread cleanup** — evict at 100 entries (5168929)
7. **Model selection** — "codex" provider in custom models UI (8a9b692)

## Next Up

### 8. Context window / token tracking
`TokenContextWindow()` returns hardcoded 200k. Should query from Codex's `model/list` or thread/start response.

### 9. Streaming / incremental display
Cross-cutting concern (not Codex-specific). `llm.Service.Do()` is synchronous. Codex sends `agentMessage/delta` notifications we ignore. Requires changes at every layer.

### 10. Codex login flow in UI
UI button to trigger `codex login` via `v2/LoginAccountParams` JSON-RPC.

### 11. Reasoning display
Codex `reasoning` items have `summary` arrays. Currently concatenated into one thinking block.

### 12. Approval forwarding to UI
Forward command/file approvals to Shelley's UI for user confirmation.

## Architecture Notes

- Per-thread subscription channels handle concurrent multi-conversation access.
- Codex's app-server protocol is experimental and may change.
- Protocol schemas at `/tmp/codex-schema/v2/`.
- The `codex.Service` mutex is only for process lifecycle + thread map; turn execution is lock-free.
