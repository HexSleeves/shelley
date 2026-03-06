// Package client implements the Shelley CLI client.
// It communicates with a running Shelley server over a Unix socket or HTTP.
package client

import (
	"bufio"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

// ANSI color codes
const (
	colorReset   = "\033[0m"
	colorDim     = "\033[2m"
	colorCyan    = "\033[36m"
	colorYellow  = "\033[33m"
	colorGreen   = "\033[32m"
	colorRed     = "\033[31m"
	colorMagenta = "\033[35m"
)

// DefaultSocketPath returns the default Unix socket path (~/.config/shelley/shelley.sock).
func DefaultSocketPath() string {
	configDir := os.Getenv("XDG_CONFIG_HOME")
	if configDir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			home = "/tmp"
		}
		configDir = filepath.Join(home, ".config")
	}
	return filepath.Join(configDir, "shelley", "shelley.sock")
}

func defaultClientURL() string {
	return "unix://" + DefaultSocketPath()
}

func parseClientURL(rawURL string) (scheme, address string, err error) {
	if strings.HasPrefix(rawURL, "unix://") {
		sockPath := strings.TrimPrefix(rawURL, "unix://")
		if sockPath == "" {
			return "", "", fmt.Errorf("unix:// URL must include a socket path")
		}
		return "unix", sockPath, nil
	}
	if strings.HasPrefix(rawURL, "http://") || strings.HasPrefix(rawURL, "https://") {
		return strings.SplitN(rawURL, "://", 2)[0], rawURL, nil
	}
	return "", "", fmt.Errorf("unsupported URL scheme: %s (use unix://, http://, or https://)", rawURL)
}

type multiFlag []string

func (f *multiFlag) String() string { return strings.Join(*f, ", ") }

func (f *multiFlag) Set(value string) error {
	*f = append(*f, value)
	return nil
}

type outputConfig struct {
	jsonMode bool
	color    bool
	writer   io.Writer
}

func (o *outputConfig) dim(s string) string {
	if !o.color {
		return s
	}
	return colorDim + s + colorReset
}

func (o *outputConfig) cyan(s string) string {
	if !o.color {
		return s
	}
	return colorCyan + s + colorReset
}

func (o *outputConfig) yellow(s string) string {
	if !o.color {
		return s
	}
	return colorYellow + s + colorReset
}

func (o *outputConfig) green(s string) string {
	if !o.color {
		return s
	}
	return colorGreen + s + colorReset
}

func (o *outputConfig) red(s string) string {
	if !o.color {
		return s
	}
	return colorRed + s + colorReset
}

func (o *outputConfig) magenta(s string) string {
	if !o.color {
		return s
	}
	return colorMagenta + s + colorReset
}

type clientConfig struct {
	serverURL string
	headers   map[string]string
	output    outputConfig
}

func (cc *clientConfig) newHTTPClient() (*http.Client, string, error) {
	scheme, address, err := parseClientURL(cc.serverURL)
	if err != nil {
		return nil, "", err
	}

	switch scheme {
	case "unix":
		transport := &http.Transport{
			DialContext: func(_ context.Context, _, _ string) (net.Conn, error) {
				return net.Dial("unix", address)
			},
		}
		return &http.Client{Transport: transport}, "http://localhost", nil
	case "http", "https":
		return &http.Client{}, address, nil
	default:
		return nil, "", fmt.Errorf("unsupported scheme: %s", scheme)
	}
}

func (cc *clientConfig) newRequest(method, url string, body *strings.Reader) (*http.Request, error) {
	var req *http.Request
	var err error
	if body != nil {
		req, err = http.NewRequest(method, url, body)
	} else {
		req, err = http.NewRequest(method, url, nil)
	}
	if err != nil {
		return nil, err
	}
	if method == http.MethodPost {
		req.Header.Set("X-Shelley-Request", "1")
	}
	for k, v := range cc.headers {
		req.Header.Set(k, v)
	}
	return req, nil
}

// isColorEnabled checks if color output should be enabled
func isColorEnabled(noColorFlag bool) bool {
	if noColorFlag {
		return false
	}
	if os.Getenv("NO_COLOR") != "" {
		return false
	}
	// Check if stdout is a terminal
	if fileInfo, _ := os.Stdout.Stat(); (fileInfo.Mode() & os.ModeCharDevice) != 0 {
		return true
	}
	return false
}

// Run is the entry point for "shelley client [args...]".
func Run(args []string) {
	fs := flag.NewFlagSet("client", flag.ExitOnError)
	urlFlag := fs.String("url", defaultClientURL(), "Server URL (unix:///path, http://host:port, https://host:port)")
	jsonFlag := fs.Bool("json", false, "Output JSON lines (for scripting)")
	noColorFlag := fs.Bool("no-color", false, "Disable colored output")
	var headerFlags multiFlag
	fs.Var(&headerFlags, "H", `Extra HTTP header ("Name: Value", can be repeated)`)
	fs.Usage = func() {
		fmt.Fprintf(fs.Output(), "Shelley CLI client\n\n")
		fmt.Fprintf(fs.Output(), "Usage: shelley client [flags] <command> [args...]\n\n")
		fmt.Fprintf(fs.Output(), "Flags:\n")
		fs.PrintDefaults()
		fmt.Fprintf(fs.Output(), "\nCommands:\n")
		fmt.Fprintf(fs.Output(), "  chat       Send a message and wait for response (default)\n")
		fmt.Fprintf(fs.Output(), "  read       Read conversation messages\n")
		fmt.Fprintf(fs.Output(), "  list       List conversations\n")
		fmt.Fprintf(fs.Output(), "  archive    Archive a conversation\n")
		fmt.Fprintf(fs.Output(), "  unarchive  Unarchive a conversation\n")
		fmt.Fprintf(fs.Output(), "  delete     Delete a conversation\n")
		fmt.Fprintf(fs.Output(), "  models     List available models\n")
		fmt.Fprintf(fs.Output(), "  help       Print detailed help\n")
	}
	fs.Parse(args)

	headers := make(map[string]string)
	for _, h := range headerFlags {
		parts := strings.SplitN(h, ":", 2)
		if len(parts) != 2 {
			fmt.Fprintf(os.Stderr, "Error: invalid header %q (expected \"Name: Value\")\n", h)
			os.Exit(1)
		}
		headers[strings.TrimSpace(parts[0])] = strings.TrimSpace(parts[1])
	}

	cc := &clientConfig{
		serverURL: *urlFlag,
		headers:   headers,
		output: outputConfig{
			jsonMode: *jsonFlag,
			color:    isColorEnabled(*noColorFlag),
			writer:   os.Stdout,
		},
	}

	subArgs := fs.Args()
	if len(subArgs) == 0 {
		fs.Usage()
		os.Exit(1)
	}

	switch subArgs[0] {
	case "chat":
		cmdChat(cc, subArgs[1:])
	case "read":
		cmdRead(cc, subArgs[1:])
	case "list":
		cmdList(cc, subArgs[1:])
	case "archive":
		cmdArchive(cc, subArgs[1:])
	case "unarchive":
		cmdUnarchive(cc, subArgs[1:])
	case "delete":
		cmdDelete(cc, subArgs[1:])
	case "models":
		cmdModels(cc, subArgs[1:])
	case "help":
		cmdHelp()
	default:
		fmt.Fprintf(os.Stderr, "Unknown command: %s\n", subArgs[0])
		fs.Usage()
		os.Exit(1)
	}
}

func cmdChat(cc *clientConfig, args []string) {
	fs := flag.NewFlagSet("client chat", flag.ExitOnError)
	prompt := fs.String("p", "", "Message to send (use '-' to read from stdin)")
	convID := fs.String("c", "", "Conversation ID to continue (creates new if omitted)")
	model := fs.String("model", "", "Model to use (server default if empty)")
	cwd := fs.String("cwd", "", "Working directory for the conversation")
	immediate := fs.Bool("immediate", false, "Return immediately with conversation ID (don't wait for response)")
	fs.Parse(args)

	// Handle prompt from stdin
	promptText := *prompt
	if promptText == "-" {
		data, err := io.ReadAll(os.Stdin)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error reading stdin: %v\n", err)
			os.Exit(1)
		}
		promptText = string(data)
	} else if promptText == "" && fs.NArg() > 0 {
		// Allow: shelley client chat "prompt text"
		promptText = strings.Join(fs.Args(), " ")
	}

	if promptText == "" {
		fmt.Fprintf(os.Stderr, "Error: message required (-p PROMPT or pass as argument)\n")
		os.Exit(1)
	}

	client, baseURL, err := cc.newHTTPClient()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	reqBody := map[string]string{"message": promptText}
	if *model != "" {
		reqBody["model"] = *model
	}
	if *cwd != "" {
		reqBody["cwd"] = *cwd
	}

	bodyBytes, err := json.Marshal(reqBody)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	var apiURL string
	if *convID != "" {
		apiURL = baseURL + "/api/conversation/" + *convID + "/chat"
	} else {
		apiURL = baseURL + "/api/conversations/new"
	}

	req, err := cc.newRequest("POST", apiURL, strings.NewReader(string(bodyBytes)))
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error creating request: %v\n", err)
		os.Exit(1)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusAccepted {
		var errBody map[string]any
		if json.NewDecoder(resp.Body).Decode(&errBody) == nil {
			fmt.Fprintf(os.Stderr, "Error (HTTP %d): %v\n", resp.StatusCode, errBody)
		} else {
			fmt.Fprintf(os.Stderr, "Error: HTTP %d\n", resp.StatusCode)
		}
		os.Exit(1)
	}

	var respBody map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&respBody); err != nil {
		fmt.Fprintf(os.Stderr, "Error parsing response: %v\n", err)
		os.Exit(1)
	}

	cid, _ := respBody["conversation_id"].(string)
	if cid == "" {
		cid = *convID // when continuing, the chat endpoint doesn't echo the ID back
	}

	// Only print conversation ID for new conversations
	if *convID == "" {
		fmt.Fprintf(os.Stderr, "Conversation ID: %s\n", cid)
	}

	if *immediate {
		// Immediate mode: don't wait for response
		return
	}

	// Stream the response to stdout
	streamConversation(cc, client, baseURL, cid, true)
}

// streamConversation streams messages from a conversation until the turn ends.
// If onlyNewAgentMessages is true, it skips user messages and only shows the latest agent turn.
func streamConversation(cc *clientConfig, client *http.Client, baseURL, conversationID string, onlyNewAgentMessages bool) {
	req, err := cc.newRequest("GET", baseURL+"/api/conversation/"+conversationID+"/stream", nil)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error creating request: %v\n", err)
		os.Exit(1)
	}
	req.Header.Set("Accept", "text/event-stream")

	resp, err := client.Do(req)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		fmt.Fprintf(os.Stderr, "Error: HTTP %d\n", resp.StatusCode)
		os.Exit(1)
	}

	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 0, 64*1024), 10*1024*1024)

	seenSeqIDs := make(map[int64]bool)
	var lastUserSeqID int64
	firstBatch := true

	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		data := strings.TrimPrefix(line, "data: ")

		var sr streamResponseWire
		if err := json.Unmarshal([]byte(data), &sr); err != nil {
			continue
		}

		if sr.Heartbeat || len(sr.Messages) == 0 {
			continue
		}

		// On first batch, find the last user message seq ID if we're filtering
		if firstBatch && onlyNewAgentMessages {
			for _, msg := range sr.Messages {
				if msg.Type == "user" {
					lastUserSeqID = msg.SequenceID
				}
			}
			firstBatch = false
		}

		for _, msg := range sr.Messages {
			if seenSeqIDs[msg.SequenceID] {
				continue
			}
			seenSeqIDs[msg.SequenceID] = true

			// Skip messages before and including the last user message when filtering
			if onlyNewAgentMessages && msg.SequenceID <= lastUserSeqID {
				continue
			}

			if cc.output.jsonMode {
				event := simplifyMessage(msg)
				json.NewEncoder(cc.output.writer).Encode(event)
			} else {
				printMessageText(cc, msg)
			}

			endOfTurn := msg.EndOfTurn != nil && *msg.EndOfTurn
			if (msg.Type == "agent" || msg.Type == "error") && endOfTurn {
				if !cc.output.jsonMode {
					fmt.Fprintln(cc.output.writer) // Final newline
				}
				return
			}
		}
	}

	if err := scanner.Err(); err != nil {
		fmt.Fprintf(os.Stderr, "Error reading stream: %v\n", err)
		os.Exit(1)
	}
}

// printMessageText prints a message in human-readable text format
func printMessageText(cc *clientConfig, msg messageWire) {
	if msg.LlmData == nil {
		return
	}

	var llmMsg llmMessageWire
	if err := json.Unmarshal([]byte(*msg.LlmData), &llmMsg); err != nil {
		return
	}

	for _, c := range llmMsg.Content {
		switch c.Type {
		case contentTypeThinking:
			if c.Thinking != "" {
				// Print thinking in dim color
				fmt.Fprint(cc.output.writer, cc.output.dim(c.Thinking))
			}
		case contentTypeText:
			if c.Text != "" {
				fmt.Fprint(cc.output.writer, c.Text)
			}
		case contentTypeToolUse:
			if c.ToolName != "" {
				fmt.Fprintf(cc.output.writer, "\n%s\n", cc.output.cyan("["+c.ToolName+"]"))
			}
		case contentTypeToolResult:
			// Tool results can be verbose, show abbreviated
			if c.Text != "" {
				text := c.Text
				if len(text) > 500 {
					text = text[:500] + "..."
				}
				fmt.Fprintf(cc.output.writer, "%s\n", cc.output.dim(text))
			}
		}
	}
}

func cmdRead(cc *clientConfig, args []string) {
	fs := flag.NewFlagSet("client read", flag.ExitOnError)
	follow := fs.Bool("f", false, "Follow/stream until agent turn finishes")
	fs.Parse(args)

	if fs.NArg() == 0 {
		fmt.Fprintf(os.Stderr, "Usage: shelley client read [-f] CONVERSATION_ID\n")
		os.Exit(1)
	}
	conversationID := fs.Arg(0)

	client, baseURL, err := cc.newHTTPClient()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	if *follow {
		streamConversation(cc, client, baseURL, conversationID, false)
	} else {
		readSnapshot(cc, client, baseURL, conversationID)
	}
}

func readSnapshot(cc *clientConfig, client *http.Client, baseURL, conversationID string) {
	req, err := cc.newRequest("GET", baseURL+"/api/conversation/"+conversationID, nil)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error creating request: %v\n", err)
		os.Exit(1)
	}

	resp, err := client.Do(req)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		fmt.Fprintf(os.Stderr, "Error: HTTP %d\n", resp.StatusCode)
		os.Exit(1)
	}

	var sr streamResponseWire
	if err := json.NewDecoder(resp.Body).Decode(&sr); err != nil {
		fmt.Fprintf(os.Stderr, "Error parsing response: %v\n", err)
		os.Exit(1)
	}

	for _, msg := range sr.Messages {
		if cc.output.jsonMode {
			json.NewEncoder(cc.output.writer).Encode(simplifyMessage(msg))
		} else {
			printMessageForRead(cc, msg)
		}
	}
}

// printMessageForRead prints a message with role prefix for read command
func printMessageForRead(cc *clientConfig, msg messageWire) {
	var prefix string
	switch msg.Type {
	case "user":
		prefix = cc.output.green("USER: ")
	case "agent":
		prefix = cc.output.cyan("AGENT: ")
	case "error":
		prefix = cc.output.red("ERROR: ")
	default:
		return
	}

	if msg.LlmData == nil {
		return
	}

	var llmMsg llmMessageWire
	if err := json.Unmarshal([]byte(*msg.LlmData), &llmMsg); err != nil {
		return
	}

	var texts []string
	for _, c := range llmMsg.Content {
		switch c.Type {
		case contentTypeText:
			if c.Text != "" {
				texts = append(texts, c.Text)
			}
		case contentTypeThinking:
			if c.Thinking != "" {
				texts = append(texts, cc.output.dim("[thinking] "+c.Thinking))
			}
		case contentTypeToolUse:
			if c.ToolName != "" {
				texts = append(texts, cc.output.yellow("[tool: "+c.ToolName+"]"))
			}
		}
	}

	if len(texts) > 0 {
		fmt.Fprintf(cc.output.writer, "%s%s\n\n", prefix, strings.Join(texts, "\n"))
	}
}

func cmdList(cc *clientConfig, args []string) {
	fs := flag.NewFlagSet("client list", flag.ExitOnError)
	archived := fs.Bool("a", false, "List archived conversations")
	limit := fs.Int("limit", 20, "Maximum number of conversations")
	query := fs.String("q", "", "Search query")
	fs.Parse(args)

	client, baseURL, err := cc.newHTTPClient()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	endpoint := "/api/conversations"
	if *archived {
		endpoint = "/api/conversations/archived"
	}

	params := fmt.Sprintf("?limit=%d", *limit)
	if *query != "" {
		params += "&q=" + url.QueryEscape(*query)
	}

	req, err := cc.newRequest("GET", baseURL+endpoint+params, nil)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error creating request: %v\n", err)
		os.Exit(1)
	}

	resp, err := client.Do(req)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		fmt.Fprintf(os.Stderr, "Error: HTTP %d\n", resp.StatusCode)
		os.Exit(1)
	}

	var conversations []conversationWire
	if err := json.NewDecoder(resp.Body).Decode(&conversations); err != nil {
		fmt.Fprintf(os.Stderr, "Error parsing response: %v\n", err)
		os.Exit(1)
	}

	if cc.output.jsonMode {
		for _, c := range conversations {
			json.NewEncoder(cc.output.writer).Encode(c)
		}
	} else {
		for _, c := range conversations {
			slug := ""
			if c.Slug != nil {
				slug = *c.Slug
			}
			model := ""
			if c.Model != nil {
				model = *c.Model
			}
			working := ""
			if c.Working {
				working = cc.output.yellow(" [working]")
			}
			fmt.Fprintf(cc.output.writer, "%s  %s  %s%s\n",
				cc.output.cyan(c.ConversationID),
				cc.output.dim(model),
				slug,
				working,
			)
		}
	}
}

func cmdArchive(cc *clientConfig, args []string) {
	fs := flag.NewFlagSet("client archive", flag.ExitOnError)
	fs.Parse(args)

	if fs.NArg() == 0 {
		fmt.Fprintf(os.Stderr, "Usage: shelley client archive CONVERSATION_ID\n")
		os.Exit(1)
	}
	conversationID := fs.Arg(0)

	client, baseURL, err := cc.newHTTPClient()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	req, err := cc.newRequest("POST", baseURL+"/api/conversation/"+conversationID+"/archive", nil)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error creating request: %v\n", err)
		os.Exit(1)
	}

	resp, err := client.Do(req)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		fmt.Fprintf(os.Stderr, "Error: HTTP %d\n", resp.StatusCode)
		os.Exit(1)
	}

	if !cc.output.jsonMode {
		fmt.Fprintf(os.Stderr, "Archived %s\n", conversationID)
	}
}

func cmdUnarchive(cc *clientConfig, args []string) {
	fs := flag.NewFlagSet("client unarchive", flag.ExitOnError)
	fs.Parse(args)

	if fs.NArg() == 0 {
		fmt.Fprintf(os.Stderr, "Usage: shelley client unarchive CONVERSATION_ID\n")
		os.Exit(1)
	}
	conversationID := fs.Arg(0)

	client, baseURL, err := cc.newHTTPClient()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	req, err := cc.newRequest("POST", baseURL+"/api/conversation/"+conversationID+"/unarchive", nil)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error creating request: %v\n", err)
		os.Exit(1)
	}

	resp, err := client.Do(req)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		fmt.Fprintf(os.Stderr, "Error: HTTP %d\n", resp.StatusCode)
		os.Exit(1)
	}

	if !cc.output.jsonMode {
		fmt.Fprintf(os.Stderr, "Unarchived %s\n", conversationID)
	}
}

func cmdDelete(cc *clientConfig, args []string) {
	fs := flag.NewFlagSet("client delete", flag.ExitOnError)
	fs.Parse(args)

	if fs.NArg() == 0 {
		fmt.Fprintf(os.Stderr, "Usage: shelley client delete CONVERSATION_ID\n")
		os.Exit(1)
	}
	conversationID := fs.Arg(0)

	client, baseURL, err := cc.newHTTPClient()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	req, err := cc.newRequest("POST", baseURL+"/api/conversation/"+conversationID+"/delete", nil)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error creating request: %v\n", err)
		os.Exit(1)
	}

	resp, err := client.Do(req)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNoContent {
		fmt.Fprintf(os.Stderr, "Error: HTTP %d\n", resp.StatusCode)
		os.Exit(1)
	}

	if !cc.output.jsonMode {
		fmt.Fprintf(os.Stderr, "Deleted %s\n", conversationID)
	}
}

func cmdModels(cc *clientConfig, args []string) {
	fs := flag.NewFlagSet("client models", flag.ExitOnError)
	fs.Parse(args)

	client, baseURL, err := cc.newHTTPClient()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	req, err := cc.newRequest("GET", baseURL+"/api/models", nil)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error creating request: %v\n", err)
		os.Exit(1)
	}

	resp, err := client.Do(req)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		fmt.Fprintf(os.Stderr, "Error: HTTP %d\n", resp.StatusCode)
		os.Exit(1)
	}

	var models []modelWire
	if err := json.NewDecoder(resp.Body).Decode(&models); err != nil {
		fmt.Fprintf(os.Stderr, "Error parsing response: %v\n", err)
		os.Exit(1)
	}

	if cc.output.jsonMode {
		for _, m := range models {
			json.NewEncoder(cc.output.writer).Encode(m)
		}
	} else {
		for _, m := range models {
			status := cc.output.red("not ready")
			if m.Ready {
				status = cc.output.green("ready")
			}
			fmt.Fprintf(cc.output.writer, "%s  %s\n", cc.output.cyan(m.ID), status)
		}
	}
}

// --- Wire types for JSON parsing ---

type streamResponseWire struct {
	Messages  []messageWire `json:"messages"`
	Heartbeat bool          `json:"heartbeat"`
}

type messageWire struct {
	SequenceID int64   `json:"sequence_id"`
	Type       string  `json:"type"`
	LlmData    *string `json:"llm_data,omitempty"`
	EndOfTurn  *bool   `json:"end_of_turn,omitempty"`
}

type llmMessageWire struct {
	Content []llmContentWire `json:"Content"`
}

type llmContentWire struct {
	Type     int    `json:"Type"`
	Text     string `json:"Text,omitempty"`
	Thinking string `json:"Thinking,omitempty"`
	ToolName string `json:"ToolName,omitempty"`
}

type conversationWire struct {
	ConversationID string  `json:"conversation_id"`
	Slug           *string `json:"slug"`
	CreatedAt      string  `json:"created_at"`
	UpdatedAt      string  `json:"updated_at"`
	Working        bool    `json:"working"`
	Model          *string `json:"model"`
}

type modelWire struct {
	ID    string `json:"id"`
	Ready bool   `json:"ready"`
}

// Content type constants matching llm.ContentType iota values from llm/llm.go.
const (
	contentTypeThinking   = 1
	contentTypeText       = 2
	contentTypeToolUse    = 5
	contentTypeToolResult = 6
)

// streamEvent is the simplified output format for JSON mode.
type streamEvent struct {
	SequenceID int64  `json:"sequence_id"`
	Type       string `json:"type"`
	Text       string `json:"text,omitempty"`
	Thinking   string `json:"thinking,omitempty"`
	ToolName   string `json:"tool_name,omitempty"`
	EndOfTurn  bool   `json:"end_of_turn"`
}

func simplifyMessage(msg messageWire) streamEvent {
	event := streamEvent{
		SequenceID: msg.SequenceID,
		Type:       msg.Type,
	}

	if msg.EndOfTurn != nil {
		event.EndOfTurn = *msg.EndOfTurn
	}

	if msg.LlmData == nil {
		return event
	}

	var llmMsg llmMessageWire
	if err := json.Unmarshal([]byte(*msg.LlmData), &llmMsg); err != nil {
		return event
	}

	var texts []string
	var thinkingTexts []string
	for _, c := range llmMsg.Content {
		switch c.Type {
		case contentTypeThinking:
			if c.Thinking != "" {
				thinkingTexts = append(thinkingTexts, c.Thinking)
			}
		case contentTypeText:
			if c.Text != "" {
				texts = append(texts, c.Text)
			}
		case contentTypeToolUse:
			if event.ToolName == "" && c.ToolName != "" {
				event.ToolName = c.ToolName
			}
		case contentTypeToolResult:
			if c.Text != "" {
				texts = append(texts, c.Text)
			}
		}
	}
	event.Text = strings.Join(texts, "\n")
	event.Thinking = strings.Join(thinkingTexts, "\n")

	return event
}

func cmdHelp() {
	fmt.Printf(`Shelley CLI Client

Usage:
  shelley client [flags] <command> [args...]

Global Flags:
  -url URL       Server URL (default: unix://%s)
  -json          Output JSON instead of text
  -no-color      Disable colored output
  -H HEADER      Extra HTTP header "Name: Value" (repeatable)

Commands:
  chat [-p] PROMPT [-c ID] [-model MODEL] [--immediate]
      Send a message and stream the response.
      Conversation ID is printed to stderr, response to stdout.
      Creates a new conversation unless -c is given.
      With --immediate, prints ID and exits without waiting.
      Use -p - to read prompt from stdin.

  read [-f] CONVERSATION_ID
      Read messages from a conversation.
      With -f, follows/streams until the agent turn ends.

  list [-a] [-limit N] [-q QUERY]
      List conversations. -a for archived.

  archive CONVERSATION_ID
      Archive a conversation.

  unarchive CONVERSATION_ID
      Unarchive a conversation.

  delete CONVERSATION_ID
      Delete a conversation.

  models
      List available models and their status.

  help
      Print this help text.

Examples:
  # Quick one-off question (ID goes to stderr, response to stdout)
  shelley client chat "what is 2+2?"

  # Continue a conversation
  shelley client chat -c abc123 "now do this"

  # Agent-to-agent workflow (capture ID from stderr)
  shelley client chat "start task" 2>&1  # shows ID + response
  shelley client chat -c ID "next step"   # continue

  # Read from stdin
  echo "explain this" | shelley client chat -p -

  # JSON mode for scripting
  shelley client --json chat "hello"   # JSON events to stdout

  # List models
  shelley client models
`, DefaultSocketPath())
}
