package models

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"shelley.exe.dev/db"
	"shelley.exe.dev/db/generated"
	"shelley.exe.dev/llm"
	"shelley.exe.dev/llm/codex"
	"shelley.exe.dev/llm/llmhttp"
)

// Provider represents an LLM provider
type Provider string

const (
	ProviderOpenAI    Provider = "openai"
	ProviderAnthropic Provider = "anthropic"
	ProviderFireworks Provider = "fireworks"
	ProviderGemini    Provider = "gemini"
	ProviderBuiltIn   Provider = "builtin"
)

// ModelSource describes where a model's configuration comes from
type ModelSource string

const (
	SourceGateway ModelSource = "exe.dev gateway"
	SourceEnvVar  ModelSource = "env"    // Will be combined with env var name
	SourceCustom  ModelSource = "custom" // User-configured custom model
)

// Model represents a configured LLM model in Shelley
type Model struct {
	// ID is the user-facing identifier for this model
	ID string

	// Provider is the LLM provider (OpenAI, Anthropic, etc.)
	Provider Provider

	// Description is a human-readable description
	Description string

	// Tags is a comma-separated list of tags (e.g., "slug")
	Tags string

	// RequiredEnvVars are the environment variables required for this model
	RequiredEnvVars []string

	// GatewayEnabled indicates whether this model is available when using a gateway
	GatewayEnabled bool

	// OAuthFallback indicates this model can also be exposed through OAuth credentials.
	OAuthFallback string

	// Factory creates an llm.Service instance for this model
	Factory func(config *Config, httpc *http.Client) (llm.Service, error)
}

// Source returns a human-readable description of where this model's configuration comes from.
// For example: "exe.dev gateway", "$ANTHROPIC_API_KEY", etc.
func (m Model) Source(cfg *Config) string {
	// Predictable model has no source
	if m.ID == "predictable" {
		return ""
	}

	// Check if using gateway with implicit keys
	if cfg.Gateway != "" {
		// Gateway is configured - check if this model is using gateway (implicit key)
		switch m.Provider {
		case ProviderAnthropic:
			if cfg.AnthropicAPIKey == "implicit" {
				return string(SourceGateway)
			}
			return "$ANTHROPIC_API_KEY"
		case ProviderOpenAI:
			if cfg.OpenAIAPIKey == "implicit" {
				return string(SourceGateway)
			}
			return "$OPENAI_API_KEY"
		case ProviderFireworks:
			if cfg.FireworksAPIKey == "implicit" {
				return string(SourceGateway)
			}
			return "$FIREWORKS_API_KEY"
		case ProviderGemini:
			if cfg.GeminiAPIKey == "implicit" {
				return string(SourceGateway)
			}
			return "$GEMINI_API_KEY"
		}
	}

	// No gateway - use env var names based on RequiredEnvVars
	if len(m.RequiredEnvVars) > 0 {
		return "$" + m.RequiredEnvVars[0]
	}
	return ""
}

// Config holds the configuration needed to create LLM services
type Config struct {
	// API keys for each provider
	AnthropicAPIKey string
	OpenAIAPIKey    string
	GeminiAPIKey    string
	FireworksAPIKey string

	// Gateway is the base URL of the LLM gateway (optional)
	// If set, model-specific suffixes will be appended
	Gateway string

	Logger *slog.Logger

	// Database for recording LLM requests (optional)
	DB *db.DB
}

// getAnthropicURL returns the Anthropic API URL, with gateway suffix if gateway is set
func (c *Config) getAnthropicURL() string {
	if c.Gateway != "" {
		return c.Gateway + "/_/gateway/anthropic/v1/messages"
	}
	return "" // use default from ant package
}

// getOpenAIURL returns the OpenAI API URL, with gateway suffix if gateway is set
func (c *Config) getOpenAIURL() string {
	if c.Gateway != "" {
		return c.Gateway + "/_/gateway/openai/v1"
	}
	return "" // use default from oai package
}

// getGeminiURL returns the Gemini API URL, with gateway suffix if gateway is set
func (c *Config) getGeminiURL() string {
	if c.Gateway != "" {
		return c.Gateway + "/_/gateway/gemini/v1/models/generate"
	}
	return "" // use default from gem package
}

// getFireworksURL returns the Fireworks API URL, with gateway suffix if gateway is set
func (c *Config) getFireworksURL() string {
	if c.Gateway != "" {
		return c.Gateway + "/_/gateway/fireworks/inference/v1"
	}
	return "" // use default from oai package
}

// All returns all available models in Shelley
func All() []Model {
	return builtInModels()
}

// ByID returns the model with the given ID, or nil if not found
func ByID(id string) *Model {
	for _, m := range All() {
		if m.ID == id {
			return &m
		}
	}
	return nil
}

// IDs returns all model IDs (not including aliases)
func IDs() []string {
	models := All()
	ids := make([]string, len(models))
	for i, m := range models {
		ids[i] = m.ID
	}
	return ids
}

// Default returns the default model
func Default() Model {
	return All()[0] // claude-opus-4.6
}

// Manager manages LLM services for all configured models
type Manager struct {
	services   map[string]serviceEntry
	modelOrder []string // ordered list of model IDs (built-in first, then custom)
	logger     *slog.Logger
	db         *db.DB       // for custom models and LLM request recording
	httpc      *http.Client // HTTP client with recording middleware
	cfg        *Config      // retained for refreshing custom models
}

type serviceEntry struct {
	service     llm.Service
	provider    Provider
	modelID     string
	source      string // Human-readable source (e.g., "exe.dev gateway", "$ANTHROPIC_API_KEY")
	displayName string // For custom models, the user-provided display name
	tags        string // For custom models, user-provided tags
}

// ConfigInfo is an optional interface that services can implement to provide configuration details for logging
type ConfigInfo interface {
	// ConfigDetails returns human-readable configuration info (e.g., URL, model name)
	ConfigDetails() map[string]string
}

// loggingService wraps an llm.Service to log request completion with usage information
type loggingService struct {
	service  llm.Service
	logger   *slog.Logger
	modelID  string
	provider Provider
	db       *db.DB
}

// Do wraps the underlying service's Do method with logging and database recording
func (l *loggingService) Do(ctx context.Context, request *llm.Request) (*llm.Response, error) {
	start := time.Now()

	// Add model ID and provider to context for the HTTP transport
	ctx = llmhttp.WithModelID(ctx, l.modelID)
	ctx = llmhttp.WithProvider(ctx, string(l.provider))

	// Call the underlying service
	response, err := l.service.Do(ctx, request)

	duration := time.Since(start)
	durationSeconds := duration.Seconds()

	// Log the completion with usage information
	if err != nil {
		logAttrs := []any{
			"model", l.modelID,
			"duration_seconds", durationSeconds,
		}

		// Add configuration details if available
		if configProvider, ok := l.service.(ConfigInfo); ok {
			for k, v := range configProvider.ConfigDetails() {
				logAttrs = append(logAttrs, k, v)
			}
		}

		logAttrs = append(logAttrs, "error", err)
		l.logger.Error("LLM request failed", logAttrs...)
	} else {
		// Log successful completion with usage info
		logAttrs := []any{
			"model", l.modelID,
			"duration_seconds", durationSeconds,
		}

		// Add usage information if available
		if !response.Usage.IsZero() {
			logAttrs = append(logAttrs,
				"input_tokens", response.Usage.InputTokens,
				"output_tokens", response.Usage.OutputTokens,
				"cost_usd", response.Usage.CostUSD,
			)
			if response.Usage.CacheCreationInputTokens > 0 {
				logAttrs = append(logAttrs, "cache_creation_input_tokens", response.Usage.CacheCreationInputTokens)
			}
			if response.Usage.CacheReadInputTokens > 0 {
				logAttrs = append(logAttrs, "cache_read_input_tokens", response.Usage.CacheReadInputTokens)
			}
		}

		l.logger.Info("LLM request completed", logAttrs...)
	}

	return response, err
}

// TokenContextWindow delegates to the underlying service
func (l *loggingService) TokenContextWindow() int {
	return l.service.TokenContextWindow()
}

// MaxImageDimension delegates to the underlying service
func (l *loggingService) MaxImageDimension() int {
	return l.service.MaxImageDimension()
}

// UseSimplifiedPatch delegates to the underlying service if it supports it
func (l *loggingService) UseSimplifiedPatch() bool {
	if sp, ok := l.service.(llm.SimplifiedPatcher); ok {
		return sp.UseSimplifiedPatch()
	}
	return false
}

// DoStream delegates to the underlying service if it supports streaming.
func (l *loggingService) DoStream(ctx context.Context, request *llm.Request, onText func(string)) (*llm.Response, error) {
	return l.DoStreamWithThinking(ctx, request, onText, nil)
}

// DoStreamWithThinking delegates to the underlying service if it supports streaming.
func (l *loggingService) DoStreamWithThinking(ctx context.Context, request *llm.Request, onText func(string), onThinking func(string)) (*llm.Response, error) {
	start := time.Now()

	// Add model ID and provider to context for the HTTP transport
	ctx = llmhttp.WithModelID(ctx, l.modelID)
	ctx = llmhttp.WithProvider(ctx, string(l.provider))

	var (
		response *llm.Response
		err      error
	)

	if thinkingSvc, ok := l.service.(llm.ThinkingStreamingService); ok {
		response, err = thinkingSvc.DoStreamWithThinking(ctx, request, onText, onThinking)
	} else if streamingSvc, ok := l.service.(llm.StreamingService); ok {
		response, err = streamingSvc.DoStream(ctx, request, onText)
	} else {
		response, err = l.service.Do(ctx, request)
	}

	duration := time.Since(start)
	durationSeconds := duration.Seconds()

	if err != nil {
		l.logger.Error("LLM streaming request failed",
			"model", l.modelID,
			"duration_seconds", durationSeconds,
			"error", err)
	} else {
		logAttrs := []any{
			"model", l.modelID,
			"duration_seconds", durationSeconds,
			"streaming", true,
		}
		if response != nil && !response.Usage.IsZero() {
			logAttrs = append(logAttrs,
				"input_tokens", response.Usage.InputTokens,
				"output_tokens", response.Usage.OutputTokens,
				"cost_usd", response.Usage.CostUSD,
			)
		}
		l.logger.Info("LLM streaming request completed", logAttrs...)
	}

	return response, err
}

// Verify loggingService implements streaming interfaces.
var _ llm.StreamingService = (*loggingService)(nil)
var _ llm.ThinkingStreamingService = (*loggingService)(nil)

// NewManager creates a new Manager with all models configured
func NewManager(cfg *Config) (*Manager, error) {
	manager := &Manager{
		services: make(map[string]serviceEntry),
		logger:   cfg.Logger,
		db:       cfg.DB,
	}

	// Create HTTP client with recording if database is available
	var httpc *http.Client
	if cfg.DB != nil {
		recorder := func(ctx context.Context, url string, requestBody, responseBody []byte, statusCode int, err error, duration time.Duration) {
			modelID := llmhttp.ModelIDFromContext(ctx)
			provider := llmhttp.ProviderFromContext(ctx)
			conversationID := llmhttp.ConversationIDFromContext(ctx)

			var convIDPtr *string
			if conversationID != "" {
				convIDPtr = &conversationID
			}

			var reqBodyPtr, respBodyPtr *string
			if len(requestBody) > 0 {
				s := string(requestBody)
				reqBodyPtr = &s
			}
			if len(responseBody) > 0 {
				s := string(responseBody)
				respBodyPtr = &s
			}

			var statusCodePtr *int64
			if statusCode != 0 {
				sc := int64(statusCode)
				statusCodePtr = &sc
			}

			var errPtr *string
			if err != nil {
				s := err.Error()
				errPtr = &s
			}

			durationMs := duration.Milliseconds()
			durationMsPtr := &durationMs

			// Insert into database (fire and forget, don't block the request)
			go func() {
				_, insertErr := cfg.DB.InsertLLMRequest(context.Background(), generated.InsertLLMRequestParams{
					ConversationID: convIDPtr,
					Model:          modelID,
					Provider:       provider,
					Url:            url,
					RequestBody:    reqBodyPtr,
					ResponseBody:   respBodyPtr,
					StatusCode:     statusCodePtr,
					Error:          errPtr,
					DurationMs:     durationMsPtr,
				})
				if insertErr != nil && cfg.Logger != nil {
					cfg.Logger.Warn("Failed to record LLM request", "error", insertErr)
				}
			}()
		}
		httpc = llmhttp.NewClient(nil, recorder)
	} else {
		// Still use the custom transport for headers, just without recording
		httpc = llmhttp.NewClient(nil, nil)
	}

	// Store the HTTP client and config for use with custom models
	manager.httpc = httpc
	manager.cfg = cfg

	if err := manager.reloadModels(); err != nil && cfg.Logger != nil {
		cfg.Logger.Warn("Failed to load models", "error", err)
	}

	return manager, nil
}

func (m *Manager) reloadModels() error {
	m.services = make(map[string]serviceEntry)
	m.modelOrder = nil

	m.loadBuiltInModels()
	return m.loadCustomModels()
}

func (m *Manager) loadBuiltInModels() {
	useGateway := m.cfg.Gateway != ""
	for _, model := range All() {
		if useGateway && !model.GatewayEnabled {
			continue
		}

		svc, err := model.Factory(m.cfg, m.httpc)
		if err == nil {
			m.services[model.ID] = serviceEntry{
				service:     svc,
				provider:    model.Provider,
				modelID:     model.ID,
				source:      model.Source(m.cfg),
				displayName: model.ID,
				tags:        model.Tags,
			}
			m.modelOrder = append(m.modelOrder, model.ID)
		}

		if model.OAuthFallback == "" || m.db == nil {
			continue
		}

		oauthService := m.createOAuthService(model)
		if oauthService == nil {
			continue
		}

		oauthModelID := model.ID + "-oauth"
		m.services[oauthModelID] = serviceEntry{
			service:     oauthService,
			provider:    model.Provider,
			modelID:     oauthModelID,
			source:      "OAuth",
			displayName: oauthModelID,
			tags:        model.Tags,
		}
		m.modelOrder = append(m.modelOrder, oauthModelID)
	}
}

// loadCustomModels loads custom models from the database into the manager.
// It adds them after built-in models in the order.
func (m *Manager) loadCustomModels() error {
	if m.db == nil {
		return nil
	}

	dbModels, err := m.db.GetModels(context.Background())
	if err != nil {
		return err
	}

	for _, model := range dbModels {
		// Skip if this model ID is already registered (built-in takes precedence)
		if _, exists := m.services[model.ModelID]; exists {
			continue
		}

		svc := m.createServiceFromModel(&model)
		if svc == nil {
			continue
		}

		m.services[model.ModelID] = serviceEntry{
			service:     svc,
			provider:    Provider(model.ProviderType),
			modelID:     model.ModelID,
			source:      string(SourceCustom),
			displayName: model.DisplayName,
			tags:        model.Tags,
		}
		m.modelOrder = append(m.modelOrder, model.ModelID)
	}

	return nil
}

// ReloadModels rebuilds the manager's model list from built-in and database state.
func (m *Manager) ReloadModels() error {
	return m.reloadModels()
}

// GetService returns the LLM service for the given model ID, wrapped with logging
func (m *Manager) GetService(modelID string) (llm.Service, error) {
	entry, ok := m.services[modelID]
	if !ok {
		return nil, fmt.Errorf("unsupported model: %s", modelID)
	}

	// Wrap with logging if we have a logger
	if m.logger != nil {
		return &loggingService{
			service:  entry.service,
			logger:   m.logger,
			modelID:  entry.modelID,
			provider: entry.provider,
			db:       m.db,
		}, nil
	}
	return entry.service, nil
}

// GetAvailableModels returns a list of available model IDs.
// Returns union of built-in models (in order) followed by custom models.
func (m *Manager) GetAvailableModels() []string {
	// Return a copy to prevent external modification
	result := make([]string, len(m.modelOrder))
	copy(result, m.modelOrder)
	return result
}

// HasModel reports whether the manager has a service for the given model ID
func (m *Manager) HasModel(modelID string) bool {
	_, ok := m.services[modelID]
	return ok
}

// ModelInfo contains display name, tags, and source for a model
type ModelInfo struct {
	DisplayName string
	Tags        string
	Source      string // Human-readable source (e.g., "exe.dev gateway", "$ANTHROPIC_API_KEY", "custom")
}

// GetModelInfo returns the display name, tags, and source for a model
func (m *Manager) GetModelInfo(modelID string) *ModelInfo {
	entry, ok := m.services[modelID]
	if !ok {
		return nil
	}
	return &ModelInfo{
		DisplayName: entry.displayName,
		Tags:        entry.tags,
		Source:      entry.source,
	}
}

// createServiceFromModel creates an LLM service from a database model configuration
func (m *Manager) createServiceFromModel(model *generated.Model) llm.Service {
	if spec, ok := customModelSpec(model); ok {
		svc, err := newCustomService(spec, model.ApiKey, m.httpc)
		if err != nil {
			if m.logger != nil {
				m.logger.Error("Failed to create custom model service", "model_id", model.ModelID, "error", err)
			}
			return nil
		}
		return svc
	}

	switch model.ProviderType {
	case "codex":
		return m.createCodexService(model)
	default:
		if m.logger != nil {
			m.logger.Error("Unknown provider type for model", "model_id", model.ModelID, "provider_type", model.ProviderType)
		}
		return nil
	}
}

// createCodexService creates a Codex service using OAuth credentials from the database
func (m *Manager) createCodexService(model *generated.Model) llm.Service {
	return m.newCodexOAuthService("codex", model.ModelName, int(model.MaxTokens), codexThinkingLevel(model.ModelName), "model_id", model.ModelID)
}

func (m *Manager) createOAuthService(model Model) llm.Service {
	switch model.OAuthFallback {
	case "codex":
	default:
		if m.logger != nil {
			m.logger.Error("Unknown OAuth fallback provider for model", "model_id", model.ID, "provider", model.OAuthFallback)
		}
		return nil
	}

	return m.newCodexOAuthService(model.OAuthFallback, model.ID, 0, llm.ThinkingLevelMedium, "model_id", model.ID)
}

func (m *Manager) newCodexOAuthService(provider, modelName string, maxTokens int, thinkingLevel llm.ThinkingLevel, logKey, logValue string) llm.Service {
	if m.db == nil {
		if m.logger != nil {
			m.logger.Error("Cannot create OAuth service without database", logKey, logValue, "provider", provider)
		}
		return nil
	}

	cred, err := m.db.GetOAuthCredentials(context.Background(), provider)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			if m.logger != nil {
				m.logger.Debug("OAuth provider not authenticated, skipping model", logKey, logValue, "provider", provider)
			}
			return nil
		}
		if m.logger != nil {
			m.logger.Error("Failed to get OAuth credentials", logKey, logValue, "provider", provider, "error", err)
		}
		return nil
	}

	accountID := ""
	if cred.AccountID != nil {
		accountID = *cred.AccountID
	}

	return &codex.Service{
		AccessToken:   cred.AccessToken,
		AccountID:     accountID,
		Model:         modelName,
		MaxTokens:     maxTokens,
		HTTPC:         m.httpc,
		ThinkingLevel: thinkingLevel,
	}
}

func codexThinkingLevel(modelName string) llm.ThinkingLevel {
	switch {
	case strings.Contains(modelName, "thinking-low"):
		return llm.ThinkingLevelLow
	case strings.Contains(modelName, "thinking-high"):
		return llm.ThinkingLevelHigh
	default:
		return llm.ThinkingLevelMedium
	}
}
