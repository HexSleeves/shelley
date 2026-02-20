// Package codex implements llm.Service by driving the Codex CLI app-server
// subprocess over its JSON-RPC (stdio) protocol.
//
// Shelley's tools are registered as Codex "dynamic tools". When the model
// wants to call a tool, Codex sends an item/tool/call request, we execute
// the tool via the llm.Tool.Run callback and return the result. The turn
// completes when the model is done, and we return the final text as an
// llm.Response.
package codex

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"shelley.exe.dev/llm"
	"shelley.exe.dev/llm/llmhttp"
)

// Service implements llm.Service using the Codex CLI app-server.
type Service struct {
	// CodexBin is the path to the codex binary. Defaults to "codex".
	CodexBin string
	// Model is the Codex model name (e.g. "o3", "gpt-4.1"). If empty, Codex picks its default.
	Model string

	mu      sync.Mutex
	proc    *process       // lazily started subprocess
	threads map[string]string // shelley conversation ID → codex thread ID
}

var _ llm.Service = (*Service)(nil)

// ErrUnauthorized is returned when Codex reports an auth failure.
// The user needs to run "codex login" to authenticate.
var ErrUnauthorized = fmt.Errorf("codex: not authenticated — run 'codex login' in a terminal to sign in")

func (s *Service) TokenContextWindow() int { return 200_000 }
func (s *Service) MaxImageDimension() int   { return 0 }

// ---------------------------------------------------------------------------
// JSON-RPC types
// ---------------------------------------------------------------------------

type jsonrpcRequest struct {
	ID     any             `json:"id,omitempty"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params,omitempty"`
}

type jsonrpcResponse struct {
	ID     any             `json:"id,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *jsonrpcError   `json:"error,omitempty"`
}

type jsonrpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// jsonrpcMessage is used for decoding incoming messages which may be
// requests, responses, or notifications.
type jsonrpcMessage struct {
	ID     any             `json:"id,omitempty"`
	Method string          `json:"method,omitempty"`
	Params json.RawMessage `json:"params,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *jsonrpcError   `json:"error,omitempty"`
}

func (m *jsonrpcMessage) isResponse() bool  { return m.ID != nil && m.Method == "" }
func (m *jsonrpcMessage) isRequest() bool   { return m.ID != nil && m.Method != "" }

// ---------------------------------------------------------------------------
// Codex protocol types (minimal subset)
// ---------------------------------------------------------------------------

type dynamicToolSpec struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"inputSchema"`
}

type threadStartParams struct {
	ApprovalPolicy *string           `json:"approvalPolicy,omitempty"`
	Sandbox        *string           `json:"sandbox,omitempty"`
	DynamicTools   []dynamicToolSpec `json:"dynamicTools,omitempty"`
	Model          *string           `json:"model,omitempty"`
	Cwd            *string           `json:"cwd,omitempty"`
	BaseInstructions *string         `json:"baseInstructions,omitempty"`
}

type threadStartResponse struct {
	Thread struct {
		ID string `json:"id"`
	} `json:"thread"`
}

type userInput struct {
	Type string `json:"type"`
	Text string `json:"text,omitempty"`
}

type turnStartParams struct {
	ThreadID string      `json:"threadId"`
	Input    []userInput `json:"input"`
}

type turnCompletedNotification struct {
	ThreadID string `json:"threadId"`
	Turn     struct {
		ID     string    `json:"id"`
		Status string    `json:"status"`
		Error  *turnError `json:"error,omitempty"`
	} `json:"turn"`
}

type turnError struct {
	Message        string      `json:"message"`
	CodexErrorInfo any         `json:"codexErrorInfo,omitempty"`
}

// isUnauthorized returns true if the error indicates an auth failure.
func (e *turnError) isUnauthorized() bool {
	if e == nil {
		return false
	}
	// codexErrorInfo can be the string "unauthorized" or an object.
	if s, ok := e.CodexErrorInfo.(string); ok && s == "unauthorized" {
		return true
	}
	return strings.Contains(strings.ToLower(e.Message), "unauthorized")
}

type errorNotification struct {
	ThreadID  string    `json:"threadId"`
	TurnID    string    `json:"turnId"`
	Error     turnError `json:"error"`
	WillRetry bool      `json:"willRetry"`
}

type itemCompletedNotification struct {
	ThreadID string     `json:"threadId"`
	TurnID   string     `json:"turnId"`
	Item     threadItem `json:"item"`
}

type threadItem struct {
	ID   string `json:"id"`
	Type string `json:"type"`
	// agentMessage
	Text string `json:"text,omitempty"`
	// reasoning
	Summary []string `json:"summary,omitempty"`
	Content []string `json:"content,omitempty"`
	// commandExecution
	Command          string  `json:"command,omitempty"`
	AggregatedOutput *string `json:"aggregatedOutput,omitempty"`
	ExitCode         *int    `json:"exitCode,omitempty"`
	Status           string  `json:"status,omitempty"`
	Cwd              string  `json:"cwd,omitempty"`
}

type dynamicToolCallParams struct {
	ThreadID  string          `json:"threadId"`
	TurnID    string          `json:"turnId"`
	CallID    string          `json:"callId"`
	Tool      string          `json:"tool"`
	Arguments json.RawMessage `json:"arguments"`
}

type dynamicToolCallResponse struct {
	Output  string `json:"output"`
	Success bool   `json:"success"`
}

type tokenUsageNotification struct {
	TokenUsage struct {
		Last  tokenBreakdown `json:"last"`
		Total tokenBreakdown `json:"total"`
	} `json:"tokenUsage"`
}

type tokenBreakdown struct {
	InputTokens    int64 `json:"inputTokens"`
	OutputTokens   int64 `json:"outputTokens"`
	CachedInputTokens int64 `json:"cachedInputTokens"`
}

// toolCallRecord captures a dynamic tool call for content synthesis.
type toolCallRecord struct {
	ID        string
	Name      string
	Input     json.RawMessage
	Output    string
	IsError   bool
	Display   any
	StartTime time.Time
	EndTime   time.Time
}

// ---------------------------------------------------------------------------
// Subprocess management
// ---------------------------------------------------------------------------

type process struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdinMu sync.Mutex // serializes writes to stdin
	scanner *bufio.Scanner

	nextID atomic.Int64

	// pending tracks in-flight RPC calls. The reader goroutine routes
	// responses to the correct caller.
	pendingMu sync.Mutex
	pending   map[string]chan jsonrpcMessage // id (as string) -> response channel

	// subs routes notifications and server requests by thread ID.
	subsMu sync.Mutex
	subs   map[string]chan jsonrpcMessage // threadID -> subscriber channel

	// done is closed when the reader goroutine exits.
	done chan struct{}
}

func (p *process) subscribe(threadID string) chan jsonrpcMessage {
	ch := make(chan jsonrpcMessage, 64)
	p.subsMu.Lock()
	p.subs[threadID] = ch
	p.subsMu.Unlock()
	return ch
}

func (p *process) unsubscribe(threadID string) {
	p.subsMu.Lock()
	delete(p.subs, threadID)
	p.subsMu.Unlock()
}

func (s *Service) codexBin() string {
	if s.CodexBin != "" {
		return s.CodexBin
	}
	return "codex"
}

// ensureProcess starts the codex app-server subprocess if not already running.
// Must be called with s.mu held.
func (s *Service) ensureProcess(ctx context.Context) error {
	if s.proc != nil {
		// Check if still alive.
		select {
		case <-s.proc.done:
			s.proc = nil
			s.threads = nil // stale thread IDs from dead process
		default:
			return nil
		}
	}

	// Use background context so the subprocess outlives any single request.
	cmd := exec.Command(s.codexBin(), "app-server")
	cmd.Stderr = os.Stderr // let codex logs flow to shelley's stderr

	stdinPipe, err := cmd.StdinPipe()
	if err != nil {
		return fmt.Errorf("codex stdin pipe: %w", err)
	}
	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		stdinPipe.Close()
		return fmt.Errorf("codex stdout pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		stdinPipe.Close()
		return fmt.Errorf("codex start: %w", err)
	}

	p := &process{
		cmd:     cmd,
		stdin:   stdinPipe,
		scanner: bufio.NewScanner(stdoutPipe),
		pending: make(map[string]chan jsonrpcMessage),
		subs:    make(map[string]chan jsonrpcMessage),
		done:    make(chan struct{}),
	}
	p.scanner.Buffer(make([]byte, 0, 4*1024*1024), 16*1024*1024) // 16 MB max line

	// Reader goroutine: routes responses to pending callers, broadcasts everything else.
	go func() {
		defer close(p.done)
		for p.scanner.Scan() {
			line := p.scanner.Bytes()
			if len(line) == 0 {
				continue
			}
			var msg jsonrpcMessage
			if err := json.Unmarshal(line, &msg); err != nil {
				slog.Warn("codex: unparseable line", "line", string(line), "error", err)
				continue
			}
			// If this is a response, route to the pending caller.
			if msg.isResponse() {
				key := fmt.Sprint(msg.ID)
				p.pendingMu.Lock()
				ch, ok := p.pending[key]
				p.pendingMu.Unlock()
				if ok {
					ch <- msg
					continue
				}
			}
			// Route by threadId to the correct subscriber.
			var threadHint struct {
				ThreadID string `json:"threadId"`
			}
			if msg.Params != nil {
				_ = json.Unmarshal(msg.Params, &threadHint)
			}
			p.subsMu.Lock()
			ch := p.subs[threadHint.ThreadID] // nil if no subscriber or empty threadID
			p.subsMu.Unlock()
			if ch != nil {
				select {
				case ch <- msg:
				default:
					slog.Warn("codex: thread channel full, dropping", "method", msg.Method, "threadId", threadHint.ThreadID)
				}
			} else if threadHint.ThreadID != "" {
				slog.Warn("codex: no subscriber for thread", "threadId", threadHint.ThreadID, "method", msg.Method)
			}
		}
		if err := p.scanner.Err(); err != nil {
			slog.Warn("codex: scanner error", "error", err)
		}
	}()

	s.proc = p

	// Initialize the protocol.
	if err := s.initialize(ctx); err != nil {
		s.kill()
		return fmt.Errorf("codex initialize: %w", err)
	}

	return nil
}

func (s *Service) kill() {
	if s.proc == nil {
		return
	}
	s.proc.stdin.Close()
	_ = s.proc.cmd.Process.Kill()
	_ = s.proc.cmd.Wait()
	s.proc = nil
}

// send writes a JSON-RPC message to the subprocess stdin.
func (p *process) send(v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	data = append(data, '\n')
	p.stdinMu.Lock()
	_, err = p.stdin.Write(data)
	p.stdinMu.Unlock()
	return err
}

// call sends a request and waits for the response with the matching id.
// If sub is non-nil, notifications on that channel are dispatched to handler while waiting.
func (s *Service) call(ctx context.Context, p *process, method string, params any, sub chan jsonrpcMessage, handler func(jsonrpcMessage) error) (json.RawMessage, error) {
	id := p.nextID.Add(1)
	idStr := fmt.Sprint(id)

	// Register a channel for our response.
	respCh := make(chan jsonrpcMessage, 1)
	p.pendingMu.Lock()
	p.pending[idStr] = respCh
	p.pendingMu.Unlock()
	defer func() {
		p.pendingMu.Lock()
		delete(p.pending, idStr)
		p.pendingMu.Unlock()
	}()

	paramsJSON, err := json.Marshal(params)
	if err != nil {
		return nil, err
	}

	req := jsonrpcRequest{
		ID:     id,
		Method: method,
		Params: paramsJSON,
	}
	if err := p.send(req); err != nil {
		return nil, fmt.Errorf("send %s: %w", method, err)
	}

	for {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case msg := <-respCh:
			if msg.Error != nil {
				return nil, fmt.Errorf("codex %s error %d: %s", method, msg.Error.Code, msg.Error.Message)
			}
			return msg.Result, nil
		case msg, ok := <-sub:
			if !ok {
				return nil, fmt.Errorf("codex subprocess exited")
			}
			if handler != nil {
				if err := handler(msg); err != nil {
					return nil, err
				}
			}
		case <-p.done:
			return nil, fmt.Errorf("codex subprocess exited")
		}
	}
}

// sendNotification sends a notification (no id, no response expected).
func (p *process) sendNotification(method string) error {
	return p.send(map[string]string{"method": method})
}

// respondToRequest sends a JSON-RPC response to a server-initiated request.
func (p *process) respondToRequest(id any, result any) error {
	resultJSON, err := json.Marshal(result)
	if err != nil {
		return err
	}
	return p.send(jsonrpcResponse{ID: id, Result: resultJSON})
}

func (s *Service) initialize(ctx context.Context) error {
	p := s.proc
	params := map[string]any{
		"clientInfo": map[string]string{
			"name":    "shelley",
			"version": "0.1.0",
		},
	}
	_, err := s.call(ctx, p, "initialize", params, nil, nil)
	if err != nil {
		return err
	}
	// Send "initialized" notification.
	if err := p.sendNotification("initialized"); err != nil {
		return err
	}

	// Check auth status early so we can fail fast with a clear message.
	return s.checkAuth(ctx, p)
}

func (s *Service) checkAuth(ctx context.Context, p *process) error {
	resultJSON, err := s.call(ctx, p, "account/get", map[string]any{}, nil, nil)
	if err != nil {
		slog.Warn("codex: account/get failed", "error", err)
		return nil // non-fatal; auth errors will surface during turn/start
	}
	var resp struct {
		RequiresOpenaiAuth bool `json:"requiresOpenaiAuth"`
	}
	if err := json.Unmarshal(resultJSON, &resp); err != nil {
		return nil
	}
	if resp.RequiresOpenaiAuth {
		return ErrUnauthorized
	}
	return nil
}

// ---------------------------------------------------------------------------
// Thread management
// ---------------------------------------------------------------------------

// getOrCreateThread returns the codex thread ID for the current Shelley conversation.
// It creates a new thread (with dynamic tools and system instructions) if one doesn't exist.
func (s *Service) getOrCreateThread(ctx context.Context, p *process, req *llm.Request) (string, error) {
	convID := llmhttp.ConversationIDFromContext(ctx)
	if convID == "" {
		convID = "_default"
	}

	s.mu.Lock()
	if s.threads == nil {
		s.threads = make(map[string]string)
	}
	if tid, ok := s.threads[convID]; ok {
		s.mu.Unlock()
		return tid, nil
	}
	// Evict all threads if map is too large. Threads are cheap to recreate.
	if len(s.threads) >= 100 {
		s.threads = make(map[string]string)
	}
	s.mu.Unlock()

	// Build dynamic tools from the request.
	var dynTools []dynamicToolSpec
	for _, t := range req.Tools {
		dynTools = append(dynTools, dynamicToolSpec{
			Name:        t.Name,
			Description: t.Description,
			InputSchema: t.InputSchema,
		})
	}

	// Build system instructions from request.
	var sysText string
	for _, sc := range req.System {
		if sc.Text != "" {
			if sysText != "" {
				sysText += "\n"
			}
			sysText += sc.Text
		}
	}

	// "on-request" makes Codex ask for approval on its built-in tool calls.
	// We reject those (so only our dynamic tools run) while letting the model
	// believe it has full access.
	approval := "on-request"
	sandbox := "danger-full-access"
	params := threadStartParams{
		ApprovalPolicy:   &approval,
		Sandbox:          &sandbox,
		DynamicTools:     dynTools,
	}
	if s.Model != "" {
		params.Model = &s.Model
	}
	if sysText != "" {
		params.BaseInstructions = &sysText
	}

	// Get working directory from context if available.
	if cwd, err := os.Getwd(); err == nil {
		params.Cwd = &cwd
	}

	resultJSON, err := s.call(ctx, p, "thread/start", params, nil, nil)
	if err != nil {
		return "", fmt.Errorf("thread/start: %w", err)
	}

	var resp threadStartResponse
	if err := json.Unmarshal(resultJSON, &resp); err != nil {
		return "", fmt.Errorf("parse thread/start response: %w", err)
	}

	tid := resp.Thread.ID
	if tid == "" {
		return "", fmt.Errorf("thread/start returned empty thread ID")
	}

	s.mu.Lock()
	s.threads[convID] = tid
	s.mu.Unlock()
	return tid, nil
}

// ---------------------------------------------------------------------------
// Do — the main llm.Service entry point
// ---------------------------------------------------------------------------

func (s *Service) Do(ctx context.Context, req *llm.Request) (*llm.Response, error) {
	s.mu.Lock()
	if err := s.ensureProcess(ctx); err != nil {
		s.mu.Unlock()
		return nil, err
	}
	p := s.proc
	s.mu.Unlock()

	threadID, err := s.getOrCreateThread(ctx, p, req)
	if err != nil {
		return nil, err
	}

	// Extract the latest user message text from the request.
	userText := extractLatestUserText(req)
	if userText == "" {
		return nil, fmt.Errorf("codex: no user message found in request")
	}

	// Subscribe to this thread's notifications before starting the turn.
	sub := p.subscribe(threadID)
	defer p.unsubscribe(threadID)

	// Build tool lookup.
	toolMap := make(map[string]*llm.Tool, len(req.Tools))
	for _, t := range req.Tools {
		toolMap[t.Name] = t
	}

	// Send turn/start.
	turnParams := turnStartParams{
		ThreadID: threadID,
		Input: []userInput{
			{Type: "text", Text: userText},
		},
	}

	startTime := time.Now()

	// Accumulate state while the turn runs.
	var (
		agentTexts   []string
		thinkingText string
		usage        llm.Usage
		turnDone     bool
		turnErr      error
		toolCalls    []toolCallRecord
	)

	recordToolCall := func(tc toolCallRecord) {
		toolCalls = append(toolCalls, tc)
	}

	handler := func(msg jsonrpcMessage) error {
		switch {
		case msg.isRequest():
			return s.handleServerRequest(ctx, p, msg, toolMap, recordToolCall)
		case msg.Method != "":
			// Notification.
			switch msg.Method {
			case "item/completed":
				var n itemCompletedNotification
				if err := json.Unmarshal(msg.Params, &n); err == nil {
					switch n.Item.Type {
					case "agentMessage":
						if n.Item.Text != "" {
							agentTexts = append(agentTexts, n.Item.Text)
						}
					case "reasoning":
						if len(n.Item.Summary) > 0 {
							thinkingText += strings.Join(n.Item.Summary, "\n")
						}
					}
				}
			case "turn/completed":
				var n turnCompletedNotification
				if err := json.Unmarshal(msg.Params, &n); err == nil {
		if n.Turn.Status == "failed" && n.Turn.Error != nil {
						if n.Turn.Error.isUnauthorized() {
							turnErr = ErrUnauthorized
						} else {
							turnErr = fmt.Errorf("codex turn failed: %s", n.Turn.Error.Message)
						}
					}
					turnDone = true
				}
			case "error":
				var n errorNotification
				if err := json.Unmarshal(msg.Params, &n); err == nil {
					if n.Error.isUnauthorized() {
						turnErr = ErrUnauthorized
					} else if !n.WillRetry {
						turnErr = fmt.Errorf("codex error: %s", n.Error.Message)
					}
				}
			case "thread/tokenUsage/updated":
				var n tokenUsageNotification
				if err := json.Unmarshal(msg.Params, &n); err == nil {
					usage = llm.Usage{
						InputTokens:          uint64(n.TokenUsage.Last.InputTokens),
						OutputTokens:         uint64(n.TokenUsage.Last.OutputTokens),
						CacheReadInputTokens: uint64(n.TokenUsage.Last.CachedInputTokens),
					}
				}
			}
		}
		return nil
	}

	// call sends turn/start and waits for its response; meanwhile handler
	// processes notifications and server requests until we get our response.
	_, err = s.call(ctx, p, "turn/start", turnParams, sub, handler)
	if err != nil {
		return nil, fmt.Errorf("turn/start: %w", err)
	}

	// The turn/start response comes back quickly, but the turn may still be
	// in progress. Keep draining broadcast messages until turn/completed.
	for !turnDone {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case msg, ok := <-sub:
			if !ok {
				return nil, fmt.Errorf("codex subprocess exited during turn")
			}
			if err := handler(msg); err != nil {
				return nil, err
			}
		case <-p.done:
			return nil, fmt.Errorf("codex subprocess exited during turn")
		}
	}

	if turnErr != nil {
		return nil, turnErr
	}

	endTime := time.Now()

	// Build the response.
	var content []llm.Content
	if thinkingText != "" {
		content = append(content, llm.Content{
			Type:     llm.ContentTypeThinking,
			Thinking: thinkingText,
		})
	}
	text := strings.Join(agentTexts, "\n")
	if text == "" && len(toolCalls) == 0 {
		text = "(no response)"
	}
	if text != "" {
		content = append(content, llm.Content{
			Type: llm.ContentTypeText,
			Text: text,
		})
	}

	// Synthesize tool use/result content blocks so they appear in the UI.
	for i := range toolCalls {
		tc := &toolCalls[i]
		content = append(content, llm.Content{
			Type:      llm.ContentTypeToolUse,
			ID:        tc.ID,
			ToolName:  tc.Name,
			ToolInput: tc.Input,
		})
		content = append(content, llm.Content{
			Type:             llm.ContentTypeToolResult,
			ToolUseID:        tc.ID,
			ToolError:        tc.IsError,
			ToolResult:       []llm.Content{{Type: llm.ContentTypeText, Text: tc.Output}},
			Display:          tc.Display,
			ToolUseStartTime: &tc.StartTime,
			ToolUseEndTime:   &tc.EndTime,
		})
	}

	usage.Model = s.Model
	usage.StartTime = &startTime
	usage.EndTime = &endTime

	return &llm.Response{
		Role:       llm.MessageRoleAssistant,
		Content:    content,
		StopReason: llm.StopReasonEndTurn,
		Usage:      usage,
		Model:      s.Model,
		StartTime:  &startTime,
		EndTime:    &endTime,
	}, nil
}

// ---------------------------------------------------------------------------
// Handle server-initiated requests (tool calls, approvals)
// ---------------------------------------------------------------------------

func (s *Service) handleServerRequest(ctx context.Context, p *process, msg jsonrpcMessage, tools map[string]*llm.Tool, recordToolCall func(toolCallRecord)) error {
	switch msg.Method {
	case "item/tool/call":
		var params dynamicToolCallParams
		if err := json.Unmarshal(msg.Params, &params); err != nil {
			return p.respondToRequest(msg.ID, dynamicToolCallResponse{
				Output:  fmt.Sprintf("failed to parse tool call params: %v", err),
				Success: false,
			})
		}

		tool, ok := tools[params.Tool]
		if !ok {
			return p.respondToRequest(msg.ID, dynamicToolCallResponse{
				Output:  fmt.Sprintf("unknown tool: %s", params.Tool),
				Success: false,
			})
		}

		startTime := time.Now()
		result := tool.Run(ctx, params.Arguments)
		endTime := time.Now()

		var output string
		var isError bool
		if result.Error != nil {
			output = result.Error.Error()
			isError = true
		} else {
			var texts []string
			for _, c := range result.LLMContent {
				if c.Text != "" {
					texts = append(texts, c.Text)
				}
			}
			output = strings.Join(texts, "\n")
		}

		if recordToolCall != nil {
			recordToolCall(toolCallRecord{
				ID:        params.CallID,
				Name:      params.Tool,
				Input:     params.Arguments,
				Output:    output,
				IsError:   isError,
				Display:   result.Display,
				StartTime: startTime,
				EndTime:   endTime,
			})
		}

		return p.respondToRequest(msg.ID, dynamicToolCallResponse{
			Output:  output,
			Success: !isError,
		})

	case "item/commandExecution/requestApproval":
		// Reject Codex's built-in command execution — use our dynamic tools instead.
		return p.respondToRequest(msg.ID, map[string]string{"decision": "reject"})

	case "item/fileChange/requestApproval":
		// Reject Codex's built-in file changes — use our dynamic tools instead.
		return p.respondToRequest(msg.ID, map[string]string{"decision": "reject"})

	default:
		slog.Warn("codex: unhandled server request", "method", msg.Method)
		// Respond with an error so Codex doesn't hang.
		return p.send(jsonrpcResponse{
			ID:    msg.ID,
			Error: &jsonrpcError{Code: -1, Message: "unhandled method: " + msg.Method},
		})
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// extractLatestUserText finds the last user message's text content.
func extractLatestUserText(req *llm.Request) string {
	for i := len(req.Messages) - 1; i >= 0; i-- {
		if req.Messages[i].Role == llm.MessageRoleUser {
			var texts []string
			for _, c := range req.Messages[i].Content {
				if c.Type == llm.ContentTypeText && c.Text != "" {
					texts = append(texts, c.Text)
				}
			}
			if len(texts) > 0 {
				return strings.Join(texts, "\n")
			}
		}
	}
	return ""
}

