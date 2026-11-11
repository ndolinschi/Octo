package config

import (
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/tools"
)

const (
	defaultDataDir  = "./data/harness"
	defaultMaxTurns = 25

	DefaultMaxDepth = 3
	MaxDepthLimit   = 8
	DefaultAddr     = "127.0.0.1:8790"
	DefaultACPIdle  = 30 * time.Minute
	// DefaultRouteTimeout is how long the route call may take before the
	// harness falls back to its own default tier.
	DefaultRouteTimeout = 2500 * time.Millisecond
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
	// AutoCandidates optionally restricts and orders what spawn_agent tier
	// "auto" may choose from: fast, balanced, deep or acp:<id>[/<model>].
	// Empty means every API tier and every ready ACP agent.
	AutoCandidates []string `json:"auto_candidates,omitempty"`
}

// ValidAutoCandidate reports whether s has the shape of an auto candidate: a
// tier name or an acp:<id>[/<model>] reference (existence is checked against
// the loaded agents elsewhere).
func ValidAutoCandidate(s string) bool {
	switch s {
	case "fast", "balanced", "deep":
		return true
	}
	return strings.HasPrefix(s, "acp:")
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
	b := BuiltinModels()
	return Models{
		Orchestrator: envOr("HARNESS_MODEL_ORCHESTRATOR", b.Orchestrator),
		Fast:         envOr("HARNESS_MODEL_FAST", b.Fast),
		Balanced:     envOr("HARNESS_MODEL_BALANCED", b.Balanced),
		Deep:         envOr("HARNESS_MODEL_DEEP", b.Deep),
		TierPolicy:   TierPolicyAuto,
	}
}

// BuiltinModels returns the compiled-in tiers, with no environment applied: what
// a setting falls back to once its HARNESS_MODEL_* value is removed.
func BuiltinModels() Models {
	return Models{
		Orchestrator: "claude-sonnet-5-5",
		Fast:         "claude-haiku-5-5",
		Balanced:     "claude-sonnet-5-5",
		Deep:         "claude-opus-5-5",
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
	// NoBuiltinPlugins skips the plugins embedded in the binary
	// (--no-builtin-plugins, HARNESS_NO_BUILTIN_PLUGINS=1).
	NoBuiltinPlugins bool
	MaxTurns         int
	Stream           bool
	// PromptCaching adds cache_control breakpoints to Messages requests
	// (HARNESS_PROMPT_CACHING, default true). Turn it off for a gateway that
	// rejects the field.
	PromptCaching bool
	// Limits cap what tool results and sub-agent reports put into model context
	// (HARNESS_MAX_TOOL_RESULT_BYTES, HARNESS_MAX_REPORT_BYTES,
	// HARNESS_READ_FILE_LINES).
	Limits tools.Limits
	Models Models
	// EnvFromFile names the variables harness.env supplied (set by the serve
	// command, used by the settings API to tell them from the environment's own).
	EnvFromFile []string
	// ACPIdle is how long an ACP-run orchestrator's agent process may sit idle
	// before it is shut down (HARNESS_ACP_IDLE, a Go duration such as 90s or
	// 30m; default 30m).
	ACPIdle time.Duration
	// RouteTimeout bounds the router's route call that picks who does a
	// delegated task (HARNESS_ROUTE_TIMEOUT, a Go duration; default 2500ms).
	RouteTimeout time.Duration
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
		ACPIdle:  DefaultACPIdle,

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
	if v := os.Getenv("HARNESS_NO_BUILTIN_PLUGINS"); v != "" {
		b, err := strconv.ParseBool(v)
		if err != nil {
			return Config{}, fmt.Errorf("HARNESS_NO_BUILTIN_PLUGINS: want bool, got %q", v)
		}
		cfg.NoBuiltinPlugins = b
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
	if v := os.Getenv("HARNESS_ACP_IDLE"); v != "" {
		d, err := time.ParseDuration(v)
		if err != nil || d <= 0 {
			return Config{}, fmt.Errorf("HARNESS_ACP_IDLE: want a positive duration such as 90s or 30m, got %q", v)
		}
		cfg.ACPIdle = d
	}
	if v := os.Getenv("HARNESS_ROUTE_TIMEOUT"); v != "" {
		d, err := time.ParseDuration(v)
		if err != nil || d <= 0 {
			return Config{}, fmt.Errorf("HARNESS_ROUTE_TIMEOUT: want a positive duration such as 500ms or 4s, got %q", v)
		}
		cfg.RouteTimeout = d
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

// NoBuiltinLoopMessage is the one error every request that needs the built-in
// agent loop ends with while no API key or router is configured.
const NoBuiltinLoopMessage = "No API key is configured for the built-in agent loop. " +
	"Set ANTHROPIC_API_KEY (or a router), or choose an ACP agent for this project."

// DefaultAPIHost is the host of the Anthropic API, the base URL used when none
// is configured.
const DefaultAPIHost = "api.anthropic.com"

// BuiltinLoop reports whether the built-in agent loop (the Messages API) is
// available, decided from configuration alone, never by calling anything: an
// API key is set, or an Octo key is set, or a base URL names a host other than
// the default Anthropic API (a router or gateway that holds the credentials).
// The reason is empty when available and NoBuiltinLoopMessage otherwise.
func (c Config) BuiltinLoop() (available bool, reason string) {
	if c.APIKey != "" || c.OctoKey != "" || customBaseURL(c.BaseURL) {
		return true, ""
	}
	return false, NoBuiltinLoopMessage
}

func customBaseURL(base string) bool {
	if base == "" {
		return false
	}
	u, err := url.Parse(base)
	if err != nil || u.Hostname() == "" {
		return false
	}
	return u.Hostname() != DefaultAPIHost
}

// ResolveDataDir is the data directory before the settings file is read: the
// flag value when given, else HARNESS_DATA_DIR, else the default. (harness.env
// lives in it, so it cannot move it.)
func ResolveDataDir(flagValue string) string {
	if flagValue != "" {
		return flagValue
	}
	if v := os.Getenv("HARNESS_DATA_DIR"); v != "" {
		return v
	}
	return defaultDataDir
}
