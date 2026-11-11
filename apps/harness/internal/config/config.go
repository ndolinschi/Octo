package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"

	"github.com/ndolinschi/Octo/apps/harness/internal/tools"
)

const (
	defaultDataDir  = "./data/harness"
	defaultMaxTurns = 25

	DefaultMaxDepth = 3
	MaxDepthLimit   = 8
	DefaultAddr     = "127.0.0.1:8790"
)

// Tier policies: how an Octo router treats the tier hint (see docs).
const (
	TierPolicyAuto    = "auto"
	TierPolicyCeiling = "ceiling"
	TierPolicyFixed   = "fixed"
)

// ValidTierPolicy reports whether p is auto, ceiling or fixed.
func ValidTierPolicy(p string) bool {
	return p == TierPolicyAuto || p == TierPolicyCeiling || p == TierPolicyFixed
}

// Models maps agent kinds and tiers to model ids, plus the project's tier
// policy for an Octo router.
type Models struct {
	Orchestrator string `json:"orchestrator"`
	Fast         string `json:"fast"`
	Balanced     string `json:"balanced"`
	Deep         string `json:"deep"`
	// TierPolicy is auto, ceiling or fixed; empty means auto.
	TierPolicy string `json:"tier_policy"`
	// Side optionally overrides the model of side questions; empty means Fast.
	Side string `json:"side,omitempty"`
}

// SideModel is the model side questions run on: the project's fast tier unless
// Side overrides it.
func (m Models) SideModel() string {
	if m.Side != "" {
		return m.Side
	}
	return m.Fast
}

// Policy returns TierPolicy, defaulting to auto.
func (m Models) Policy() string {
	if m.TierPolicy == "" {
		return TierPolicyAuto
	}
	return m.TierPolicy
}

// ForTier returns the model id for a tier name, or "" for an unknown tier.
func (m Models) ForTier(tier string) string {
	switch tier {
	case "fast":
		return m.Fast
	case "balanced":
		return m.Balanced
	case "deep":
		return m.Deep
	}
	return ""
}

// DefaultModels returns the built-in tiers with HARNESS_MODEL_* overrides applied.
func DefaultModels() Models { return defaultModels() }

func defaultModels() Models {
	return Models{
		Orchestrator: envOr("HARNESS_MODEL_ORCHESTRATOR", "claude-sonnet-5-5"),
		Fast:         envOr("HARNESS_MODEL_FAST", "claude-haiku-5-5"),
		Balanced:     envOr("HARNESS_MODEL_BALANCED", "claude-sonnet-5-5"),
		Deep:         envOr("HARNESS_MODEL_DEEP", "claude-opus-5-5"),
		TierPolicy:   TierPolicyAuto,
	}
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

type Config struct {
	APIKey      string
	BaseURL     string
	OctoKey     string
	Model       string
	DataDir     string
	Workspace   string
	RemoteBases []string
	PluginDirs  []string
	MaxTurns    int
	Stream      bool
	// PromptCaching adds cache_control breakpoints to Messages requests
	// (HARNESS_PROMPT_CACHING, default true). Turn it off for a gateway that
	// rejects the field.
	PromptCaching bool
	// Limits cap what tool results and sub-agent reports put into model context
	// (HARNESS_MAX_TOOL_RESULT_BYTES, HARNESS_MAX_REPORT_BYTES,
	// HARNESS_READ_FILE_LINES).
	Limits tools.Limits
	Models Models
	// ContextWindows are per-model context sizes in tokens
	// (HARNESS_CONTEXT_WINDOWS="model=tokens,..."), on top of the built-in table.
	ContextWindows ContextWindows
}

func Load() (Config, error) {
	cfg := Config{
		APIKey:   os.Getenv("ANTHROPIC_API_KEY"),
		BaseURL:  os.Getenv("ANTHROPIC_BASE_URL"),
		OctoKey:  os.Getenv("HARNESS_OCTO_KEY"),
		DataDir:  defaultDataDir,
		MaxTurns: defaultMaxTurns,
		Stream:   true,
		Models:   defaultModels(),

		PromptCaching: true,
		Limits: tools.Limits{
			ResultBytes: tools.DefaultMaxResultBytes,
			ReportBytes: tools.DefaultMaxReportBytes,
			ReadLines:   tools.DefaultReadFileLines,
		},
	}
	windows, err := ParseContextWindows(os.Getenv("HARNESS_CONTEXT_WINDOWS"))
	if err != nil {
		return Config{}, fmt.Errorf("HARNESS_CONTEXT_WINDOWS: %w", err)
	}
	cfg.ContextWindows = windows
	for _, d := range filepath.SplitList(os.Getenv("HARNESS_PLUGINS_DIR")) {
		if d != "" {
			cfg.PluginDirs = append(cfg.PluginDirs, d)
		}
	}
	if v := os.Getenv("HARNESS_DATA_DIR"); v != "" {
		cfg.DataDir = v
	}
	if v := os.Getenv("HARNESS_MAX_TURNS"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 {
			return Config{}, fmt.Errorf("HARNESS_MAX_TURNS: want positive integer, got %q", v)
		}
		cfg.MaxTurns = n
	}
	if v := os.Getenv("HARNESS_STREAM"); v != "" {
		b, err := strconv.ParseBool(v)
		if err != nil {
			return Config{}, fmt.Errorf("HARNESS_STREAM: want bool, got %q", v)
		}
		cfg.Stream = b
	}
	if v := os.Getenv("HARNESS_PROMPT_CACHING"); v != "" {
		b, err := strconv.ParseBool(v)
		if err != nil {
			return Config{}, fmt.Errorf("HARNESS_PROMPT_CACHING: want bool, got %q", v)
		}
		cfg.PromptCaching = b
	}
	for _, c := range []struct {
		env string
		dst *int
	}{
		{"HARNESS_MAX_TOOL_RESULT_BYTES", &cfg.Limits.ResultBytes},
		{"HARNESS_MAX_REPORT_BYTES", &cfg.Limits.ReportBytes},
		{"HARNESS_READ_FILE_LINES", &cfg.Limits.ReadLines},
	} {
		v := os.Getenv(c.env)
		if v == "" {
			continue
		}
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 {
			return Config{}, fmt.Errorf("%s: want positive integer, got %q", c.env, v)
		}
		*c.dst = n
	}
	return cfg, nil
}
