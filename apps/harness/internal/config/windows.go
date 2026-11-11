package config

import (
	"fmt"
	"strconv"
	"strings"
)

// builtinWindows are the context windows (tokens) the harness knows. It is
// empty on purpose: none of the models named in the harness's tiers
// (claude-sonnet-5-5, claude-haiku-5-5, claude-opus-5-5) has a documented
// window in this repository, and a made-up size would make the context
// breakdown lie. Give a size with HARNESS_CONTEXT_WINDOWS; an unknown model
// has no window (null in the API).
var builtinWindows = map[string]int64{}

// ContextWindows maps a model id to its context window in tokens.
type ContextWindows map[string]int64

// Lookup returns the window for model: a configured override first, then the
// built-in table; nil when the model is unknown.
func (w ContextWindows) Lookup(model string) *int64 {
	if n, ok := w[model]; ok {
		return &n
	}
	if n, ok := builtinWindows[model]; ok {
		return &n
	}
	return nil
}

// ParseContextWindows reads "model=tokens,model=tokens" (HARNESS_CONTEXT_WINDOWS).
// An empty string is no overrides.
func ParseContextWindows(s string) (ContextWindows, error) {
	out := ContextWindows{}
	for _, part := range strings.Split(s, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		model, size, ok := strings.Cut(part, "=")
		model = strings.TrimSpace(model)
		n, err := strconv.ParseInt(strings.TrimSpace(size), 10, 64)
		if !ok || model == "" || err != nil || n < 1 {
			return nil, fmt.Errorf("want model=tokens with a positive integer, got %q", part)
		}
		out[model] = n
	}
	return out, nil
}
