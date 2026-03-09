package models

import (
	"fmt"
	"net/http"

	"shelley.exe.dev/db/generated"
	"shelley.exe.dev/llm"
	"shelley.exe.dev/llm/ant"
	"shelley.exe.dev/llm/gem"
	"shelley.exe.dev/llm/oai"
	"shelley.exe.dev/loop"
)

type Transport string

const (
	TransportAnthropic      Transport = "anthropic"
	TransportOpenAI         Transport = "openai"
	TransportOpenAIResponse Transport = "openai-responses"
	TransportGemini         Transport = "gemini"
	TransportBuiltIn        Transport = "builtin"
)

type PatchBehavior string

const (
	PatchBehaviorDefault    PatchBehavior = "default"
	PatchBehaviorSimplified PatchBehavior = "simplified"
)

type ModelSpec struct {
	ID                  string
	Provider            Provider
	Transport           Transport
	DisplayName         string
	ModelName           string
	OpenAIModel         oai.Model
	Tags                string
	RequiredEnvVars     []string
	GatewayEnabled      bool
	OAuthFallback       string
	ContextWindowTokens int
	MaxOutputTokens     int
	SupportsReasoning   bool
	SupportsTools       bool
	SupportsImages      bool
	APIKeyEnv           string
	Endpoint            string
	PatchBehavior       PatchBehavior
}

func Registry() []ModelSpec {
	return append([]ModelSpec(nil), builtInModelSpecs...)
}

func builtInModels() []Model {
	specs := Registry()
	models := make([]Model, 0, len(specs))
	for _, spec := range specs {
		spec := spec
		models = append(models, Model{
			ID:              spec.ID,
			Provider:        spec.Provider,
			Description:     spec.DisplayName,
			Tags:            spec.Tags,
			RequiredEnvVars: append([]string(nil), spec.RequiredEnvVars...),
			GatewayEnabled:  spec.GatewayEnabled,
			OAuthFallback:   spec.OAuthFallback,
			Factory: func(config *Config, httpc *http.Client) (llm.Service, error) {
				return newBuiltInService(spec, config, httpc)
			},
		})
	}
	return models
}

func newBuiltInService(spec ModelSpec, config *Config, httpc *http.Client) (llm.Service, error) {
	switch spec.Transport {
	case TransportAnthropic:
		apiKey := config.AnthropicAPIKey
		if apiKey == "" {
			return nil, fmt.Errorf("%s requires %s", spec.ID, ant.APIKeyEnv)
		}
		svc := &ant.Service{
			APIKey:              apiKey,
			Model:               spec.ModelName,
			HTTPC:               httpc,
			ThinkingLevel:       llm.ThinkingLevelMedium,
			ContextWindowTokens: spec.ContextWindowTokens,
		}
		if url := config.getAnthropicURL(); url != "" {
			svc.URL = url
		}
		return svc, nil
	case TransportOpenAI:
		apiKey, endpoint, err := openAIServiceConfig(spec, config)
		if err != nil {
			return nil, err
		}
		model := spec.OpenAIModel
		if model.IsZero() {
			model = oai.Model{
				ModelName:           spec.ModelName,
				URL:                 endpoint,
				ContextWindowTokens: spec.ContextWindowTokens,
				UseSimplifiedPatch:  spec.PatchBehavior == PatchBehaviorSimplified,
			}
		}
		if endpoint != "" {
			model.URL = endpoint
		}
		return &oai.Service{
			APIKey:   apiKey,
			ModelURL: endpoint,
			Model:    model,
			HTTPC:    httpc,
		}, nil
	case TransportOpenAIResponse:
		apiKey, endpoint, err := openAIServiceConfig(spec, config)
		if err != nil {
			return nil, err
		}
		model := spec.OpenAIModel
		if model.IsZero() {
			model = oai.Model{
				ModelName:           spec.ModelName,
				URL:                 endpoint,
				ContextWindowTokens: spec.ContextWindowTokens,
				UseSimplifiedPatch:  spec.PatchBehavior == PatchBehaviorSimplified,
			}
		}
		if endpoint != "" {
			model.URL = endpoint
		}
		return &oai.ResponsesService{
			Model:         model,
			APIKey:        apiKey,
			HTTPC:         httpc,
			ModelURL:      endpoint,
			ThinkingLevel: llm.ThinkingLevelMedium,
		}, nil
	case TransportGemini:
		apiKey := config.GeminiAPIKey
		if apiKey == "" {
			return nil, fmt.Errorf("%s requires %s", spec.ID, gem.GeminiAPIKeyEnv)
		}
		svc := &gem.Service{
			APIKey:              apiKey,
			Model:               spec.ModelName,
			HTTPC:               httpc,
			ContextWindowTokens: spec.ContextWindowTokens,
		}
		if url := config.getGeminiURL(); url != "" {
			svc.URL = url
		}
		return svc, nil
	case TransportBuiltIn:
		return loop.NewPredictableService(), nil
	default:
		return nil, fmt.Errorf("unsupported built-in transport %q for model %s", spec.Transport, spec.ID)
	}
}

func openAIServiceConfig(spec ModelSpec, config *Config) (apiKey string, endpoint string, err error) {
	switch spec.Provider {
	case ProviderOpenAI:
		if config.OpenAIAPIKey == "" {
			return "", "", fmt.Errorf("%s requires %s", spec.ID, oai.OpenAIAPIKeyEnv)
		}
		return config.OpenAIAPIKey, config.getOpenAIURL(), nil
	case ProviderFireworks:
		if config.FireworksAPIKey == "" {
			return "", "", fmt.Errorf("%s requires %s", spec.ID, oai.FireworksAPIKeyEnv)
		}
		return config.FireworksAPIKey, config.getFireworksURL(), nil
	default:
		return "", "", fmt.Errorf("unsupported OpenAI-compatible provider %q for model %s", spec.Provider, spec.ID)
	}
}

func customModelSpec(model *generated.Model) (ModelSpec, bool) {
	switch model.ProviderType {
	case "anthropic":
		return ModelSpec{
			ID:              model.ModelID,
			Provider:        ProviderAnthropic,
			Transport:       TransportAnthropic,
			DisplayName:     model.DisplayName,
			ModelName:       model.ModelName,
			Tags:            model.Tags,
			APIKeyEnv:       ant.APIKeyEnv,
			Endpoint:        model.Endpoint,
			MaxOutputTokens: int(model.MaxTokens),
		}, true
	case "openai":
		return ModelSpec{
			ID:              model.ModelID,
			Provider:        ProviderOpenAI,
			Transport:       TransportOpenAI,
			DisplayName:     model.DisplayName,
			ModelName:       model.ModelName,
			Tags:            model.Tags,
			APIKeyEnv:       oai.OpenAIAPIKeyEnv,
			Endpoint:        model.Endpoint,
			MaxOutputTokens: int(model.MaxTokens),
		}, true
	case "openai-responses":
		return ModelSpec{
			ID:              model.ModelID,
			Provider:        ProviderOpenAI,
			Transport:       TransportOpenAIResponse,
			DisplayName:     model.DisplayName,
			ModelName:       model.ModelName,
			Tags:            model.Tags,
			APIKeyEnv:       oai.OpenAIAPIKeyEnv,
			Endpoint:        model.Endpoint,
			MaxOutputTokens: int(model.MaxTokens),
		}, true
	case "gemini":
		return ModelSpec{
			ID:              model.ModelID,
			Provider:        ProviderGemini,
			Transport:       TransportGemini,
			DisplayName:     model.DisplayName,
			ModelName:       model.ModelName,
			Tags:            model.Tags,
			APIKeyEnv:       gem.GeminiAPIKeyEnv,
			Endpoint:        model.Endpoint,
			MaxOutputTokens: int(model.MaxTokens),
		}, true
	default:
		return ModelSpec{}, false
	}
}

func newCustomService(spec ModelSpec, apiKey string, httpc *http.Client) (llm.Service, error) {
	switch spec.Transport {
	case TransportAnthropic:
		return &ant.Service{
			APIKey:              apiKey,
			URL:                 spec.Endpoint,
			Model:               spec.ModelName,
			HTTPC:               httpc,
			ThinkingLevel:       llm.ThinkingLevelMedium,
			ContextWindowTokens: spec.ContextWindowTokens,
		}, nil
	case TransportOpenAI:
		return &oai.Service{
			APIKey:   apiKey,
			ModelURL: spec.Endpoint,
			Model: oai.Model{
				ModelName:           spec.ModelName,
				URL:                 spec.Endpoint,
				ContextWindowTokens: spec.ContextWindowTokens,
				UseSimplifiedPatch:  spec.PatchBehavior == PatchBehaviorSimplified,
			},
			MaxTokens: spec.MaxOutputTokens,
			HTTPC:     httpc,
		}, nil
	case TransportOpenAIResponse:
		return &oai.ResponsesService{
			APIKey:   apiKey,
			ModelURL: spec.Endpoint,
			Model: oai.Model{
				ModelName:           spec.ModelName,
				URL:                 spec.Endpoint,
				ContextWindowTokens: spec.ContextWindowTokens,
				UseSimplifiedPatch:  spec.PatchBehavior == PatchBehaviorSimplified,
			},
			MaxTokens:     spec.MaxOutputTokens,
			HTTPC:         httpc,
			ThinkingLevel: llm.ThinkingLevelMedium,
		}, nil
	case TransportGemini:
		return &gem.Service{
			APIKey:              apiKey,
			URL:                 spec.Endpoint,
			Model:               spec.ModelName,
			HTTPC:               httpc,
			ContextWindowTokens: spec.ContextWindowTokens,
		}, nil
	default:
		return nil, fmt.Errorf("unsupported custom transport %q for model %s", spec.Transport, spec.ID)
	}
}

func anthropicSpec(id, displayName, modelName, tags string, maxOutputTokens int) ModelSpec {
	return ModelSpec{
		ID:                  id,
		Provider:            ProviderAnthropic,
		Transport:           TransportAnthropic,
		DisplayName:         displayName,
		ModelName:           modelName,
		Tags:                tags,
		RequiredEnvVars:     []string{ant.APIKeyEnv},
		GatewayEnabled:      true,
		ContextWindowTokens: 200000,
		MaxOutputTokens:     maxOutputTokens,
		SupportsReasoning:   true,
		SupportsTools:       true,
		SupportsImages:      true,
		APIKeyEnv:           ant.APIKeyEnv,
		Endpoint:            ant.DefaultURL,
	}
}

func openAIResponseSpec(id, displayName string, model oai.Model, tags string) ModelSpec {
	patchBehavior := PatchBehaviorDefault
	if model.UseSimplifiedPatch {
		patchBehavior = PatchBehaviorSimplified
	}
	return ModelSpec{
		ID:                  id,
		Provider:            ProviderOpenAI,
		Transport:           TransportOpenAIResponse,
		DisplayName:         displayName,
		ModelName:           model.ModelName,
		OpenAIModel:         model,
		Tags:                tags,
		RequiredEnvVars:     []string{oai.OpenAIAPIKeyEnv},
		GatewayEnabled:      true,
		ContextWindowTokens: model.ContextWindowTokens,
		SupportsReasoning:   true,
		SupportsTools:       true,
		SupportsImages:      true,
		APIKeyEnv:           oai.OpenAIAPIKeyEnv,
		Endpoint:            model.URL,
		PatchBehavior:       patchBehavior,
	}
}

func openAICompatSpec(id, displayName string, provider Provider, model oai.Model, tags string, gatewayEnabled bool) ModelSpec {
	patchBehavior := PatchBehaviorDefault
	if model.UseSimplifiedPatch {
		patchBehavior = PatchBehaviorSimplified
	}
	return ModelSpec{
		ID:                  id,
		Provider:            provider,
		Transport:           TransportOpenAI,
		DisplayName:         displayName,
		ModelName:           model.ModelName,
		OpenAIModel:         model,
		Tags:                tags,
		RequiredEnvVars:     []string{model.APIKeyEnv},
		GatewayEnabled:      gatewayEnabled,
		ContextWindowTokens: model.ContextWindowTokens,
		SupportsReasoning:   model.IsReasoningModel,
		SupportsTools:       true,
		SupportsImages:      true,
		APIKeyEnv:           model.APIKeyEnv,
		Endpoint:            model.URL,
		PatchBehavior:       patchBehavior,
	}
}

func geminiSpec(id, displayName, modelName, tags string, contextWindowTokens int) ModelSpec {
	return ModelSpec{
		ID:                  id,
		Provider:            ProviderGemini,
		Transport:           TransportGemini,
		DisplayName:         displayName,
		ModelName:           modelName,
		Tags:                tags,
		RequiredEnvVars:     []string{gem.GeminiAPIKeyEnv},
		ContextWindowTokens: contextWindowTokens,
		SupportsReasoning:   true,
		SupportsTools:       true,
		SupportsImages:      true,
		APIKeyEnv:           gem.GeminiAPIKeyEnv,
	}
}

var builtInModelSpecs = []ModelSpec{
	anthropicSpec("claude-opus-4.6", "Claude Opus 4.6 (default)", ant.Claude46Opus, "", 128000),
	anthropicSpec("claude-opus-4.5", "Claude Opus 4.5", ant.Claude45Opus, "", 128000),
	anthropicSpec("claude-sonnet-4.6", "Claude Sonnet 4.6", ant.Claude46Sonnet, "", 64000),
	anthropicSpec("claude-sonnet-4.5", "Claude Sonnet 4.5", ant.Claude45Sonnet, "", 64000),
	anthropicSpec("claude-haiku-4.5", "Claude Haiku 4.5", ant.Claude45Haiku, "slug-backup", 64000),
	openAICompatSpec("glm-4.7-fireworks", "GLM-4.7 on Fireworks", ProviderFireworks, oai.GLM47Fireworks, "", true),
	withOAuthFallback(openAIResponseSpec("gpt-5.4", "GPT-5.4", oai.GPT54, ""), "codex"),
	withOAuthFallback(openAIResponseSpec("gpt-5.3-codex", "GPT-5.3 Codex", oai.GPT53Codex, ""), "codex"),
	withOAuthFallback(openAIResponseSpec("gpt-5.2-codex", "GPT-5.2 Codex", oai.GPT52Codex, ""), "codex"),
	openAICompatSpec("gpt-oss-20b-fireworks", "GPT-OSS 20B on Fireworks", ProviderFireworks, oai.GPTOSS20B, "slug", true),
	openAICompatSpec("glm-4p6-fireworks", "GLM-4P6 on Fireworks", ProviderFireworks, oai.GLM4P6Fireworks, "", false),
	geminiSpec("gemini-3-pro", "Gemini 3 Pro", "gemini-3-pro-preview", "", 1000000),
	geminiSpec("gemini-3-flash", "Gemini 3 Flash", "gemini-3-flash-preview", "", 1000000),
	{
		ID:              "predictable",
		Provider:        ProviderBuiltIn,
		Transport:       TransportBuiltIn,
		DisplayName:     "Deterministic test model (no API key)",
		GatewayEnabled:  true,
		SupportsTools:   true,
		SupportsImages:  true,
		PatchBehavior:   PatchBehaviorDefault,
		RequiredEnvVars: []string{},
	},
}

func withOAuthFallback(spec ModelSpec, provider string) ModelSpec {
	spec.OAuthFallback = provider
	return spec
}
