package plugins

import (
	"strings"
	"testing"
)

func TestParseACPRef(t *testing.T) {
	for _, tc := range []struct {
		in, id, model string
		ok            bool
	}{
		{"acp:claude-code", "claude-code", "", true},
		{"acp:grok/grok-4", "grok", "grok-4", true},
		{"acp:omp/vendor/model-2", "omp", "vendor/model-2", true},
		{"acp:", "", "", false},
		{"acp:/m", "", "", false},
		{"claude-sonnet-5-5", "", "", false},
	} {
		id, model, ok := ParseACPRef(tc.in)
		if id != tc.id || model != tc.model || ok != tc.ok {
			t.Errorf("ParseACPRef(%q) = %q, %q, %v", tc.in, id, model, ok)
		}
	}
}

func TestValidateACPRef(t *testing.T) {
	agents := []Agent{
		{ID: "fake", Available: true},
		{ID: "listed", Available: true, Models: []string{"a", "b"}},
		{ID: "gone", Available: false},
	}
	for _, ok := range []string{"claude-sonnet-5-5", "", "acp:fake", "acp:fake/anything-1", "acp:listed/a", "acp:listed/not-listed", "acp:fake/opus[1m]"} {
		if err := ValidateACPRef(ok, agents); err != nil {
			t.Errorf("ValidateACPRef(%q) = %v", ok, err)
		}
	}
	for ref, want := range map[string]string{
		"acp:nope":       `unknown ACP agent "nope"`,
		"acp:gone":       "not available",
		"acp:fake/-bad":  "invalid model",
		"acp:":           "not a valid ACP setting",
		"acp:nope/model": "available: fake, listed",
	} {
		if err := ValidateACPRef(ref, agents); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("ValidateACPRef(%q) = %v, want %q", ref, err, want)
		}
	}
	if err := ValidateACPRef("acp:x", nil); err == nil || !strings.Contains(err.Error(), "none are loaded") {
		t.Errorf("no agents: %v", err)
	}
}
