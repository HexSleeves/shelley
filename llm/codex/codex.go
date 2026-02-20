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

type turnStartResponse struct {
	Turn struct {
		ID     string `json:"id"`
		Status string `json:"status"`
	} `json:"turn"`
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
	Message string `json:"message"`
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

type agentMessageDeltaNotification struct {
	Delta string `json:"delta"`
}

// ---------------------------------------------------------------------------
// Subprocess management
// ---------------------------------------------------------------------------

type process struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	scanner *bufio.Scanner

	nextID atomic.Int64

	// incoming is fed by the reader goroutine.
	incoming chan jsonrpcMessage
	// done is closed when the reader goroutine exits.
	done chan struct{}
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
			s.proc = nil // fell through, restart
		default:
			return nil
		}
	}

	cmd := exec.CommandContext(ctx, s.codexBin(), "app-server")
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
		cmd:      cmd,
		stdin:    stdinPipe,
		scanner:  bufio.NewScanner(stdoutPipe),
		incoming: make(chan jsonrpcMessage, 64),
		done:     make(chan struct{}),
	}
	p.scanner.Buffer(make([]byte, 0, 4*1024*1024), 16*1024*1024) // 16 MB max line

	// Reader goroutine.
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
			p.incoming <- msg
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
	_, err = p.stdin.Write(data)
	return err
}

// call sends a request and waits for the response with the matching id.
// While waiting it dispatches other messages to handler.
func (s *Service) call(ctx context.Context, method string, params any, handler func(jsonrpcMessage) error) (json.RawMessage, error) {
	p := s.proc
	id := p.nextID.Add(1)

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
		case msg, ok := <-p.incoming:
			if !ok {
				return nil, fmt.Errorf("codex subprocess exited")
			}
			// Check if this is the response to our request.
			if msg.isResponse() && idEquals(msg.ID, id) {
				if msg.Error != nil {
					return nil, fmt.Errorf("codex %s error %d: %s", method, msg.Error.Code, msg.Error.Message)
				}
				return msg.Result, nil
			}
			// Otherwise dispatch.
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
	params := map[string]any{
		"clientInfo": map[string]string{
			"name":    "shelley",
			"version": "0.1.0",
		},
	}
	_, err := s.call(ctx, "initialize", params, nil)
	if err != nil {
		return err
	}
	// Send "initialized" notification.
	return s.proc.sendNotification("initialized")
}

// ---------------------------------------------------------------------------
// Thread management
// ---------------------------------------------------------------------------

func (s *Service) getOrCreateThread(ctx context.Context, req *llm.Request) (string, error) {
	convID := llmhttp.ConversationIDFromContext(ctx)
	if convID == "" {
		convID = "_default"
	}

	if s.threads == nil {
		s.threads = make(map[string]string)
	}

	if tid, ok := s.threads[convID]; ok {
		return tid, nil
	}

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

	approval := "never"
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

	resultJSON, err := s.call(ctx, "thread/start", params, nil)
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

	s.threads[convID] = tid
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

	threadID, err := s.getOrCreateThread(ctx, req)
	if err != nil {
		s.mu.Unlock()
		return nil, err
	}
	s.mu.Unlock()

	// Extract the latest user message text from the request.
	userText := extractLatestUserText(req)
	if userText == "" {
		return nil, fmt.Errorf("codex: no user message found in request")
	}

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
	)

	handler := func(msg jsonrpcMessage) error {
		switch {
		case msg.isRequest():
			return s.handleServerRequest(ctx, msg, toolMap)
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
						turnErr = fmt.Errorf("codex turn failed: %s", n.Turn.Error.Message)
					}
					turnDone = true
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
	s.mu.Lock()
	_, err = s.call(ctx, "turn/start", turnParams, handler)
	s.mu.Unlock()
	if err != nil {
		return nil, fmt.Errorf("turn/start: %w", err)
	}

	// The turn/start response comes back quickly, but the turn may still be
	// in progress. Keep draining messages until turn/completed.
	if !turnDone {
		s.mu.Lock()
		p := s.proc
		s.mu.Unlock()
		if p == nil {
			return nil, fmt.Errorf("codex process died")
		}
		for !turnDone {
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case msg, ok := <-p.incoming:
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
	if text == "" {
		text = "(no response)"
	}
	content = append(content, llm.Content{
		Type: llm.ContentTypeText,
		Text: text,
	})

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

func (s *Service) handleServerRequest(ctx context.Context, msg jsonrpcMessage, tools map[string]*llm.Tool) error {
	p := s.proc
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

		result := tool.Run(ctx, params.Arguments)
		if result.Error != nil {
			return p.respondToRequest(msg.ID, dynamicToolCallResponse{
				Output:  result.Error.Error(),
				Success: false,
			})
		}

		// Collect text from the LLM content.
		var texts []string
		for _, c := range result.LLMContent {
			if c.Text != "" {
				texts = append(texts, c.Text)
			}
		}
		return p.respondToRequest(msg.ID, dynamicToolCallResponse{
			Output:  strings.Join(texts, "\n"),
			Success: true,
		})

	case "item/commandExecution/requestApproval":
		// Auto-approve: Shelley manages its own sandbox.
		return p.respondToRequest(msg.ID, map[string]string{"decision": "accept"})

	case "item/fileChange/requestApproval":
		return p.respondToRequest(msg.ID, map[string]string{"decision": "accept"})

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

// idEquals compares two JSON-RPC ids which may be string or number.
func idEquals(a, b any) bool {
	// Normalize both to float64 (JSON numbers decode as float64).
	return fmt.Sprint(a) == fmt.Sprint(b)
}
