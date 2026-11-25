package plugins

import (
	"context"
	"testing"
)

// R5-4: a session that found the agent logged out shows it logged out, whatever
// its probe said (or without one), until a session starts fine or the login is
// checked again.
func TestSeenLoginOverridesTheProbe(t *testing.T) {
	r := &Registry{agents: map[string]Agent{"copilot": {ID: "copilot", Available: true}}}
	if a, _ := r.Agent("copilot"); a.LoggedIn != nil {
		t.Fatalf("unprobed agent logged_in = %v, want unknown", *a.LoggedIn)
	}
	if !r.SeenLogin("copilot", false) || r.SeenLogin("copilot", false) {
		t.Fatal("SeenLogin must report a change once")
	}
	if a, _ := r.Agent("copilot"); a.LoggedIn == nil || *a.LoggedIn {
		t.Fatal("an agent a session found logged out must read logged out")
	}
	r.SeenLogin("copilot", true)
	if a, _ := r.Agent("copilot"); a.LoggedIn != nil {
		t.Fatal("a session that ran must clear the mark")
	}
	r.SeenLogin("copilot", false)
	r.Recheck(context.Background(), "copilot")
	if a, _ := r.Agent("copilot"); a.LoggedIn != nil {
		t.Fatal("Recheck must clear the mark")
	}
	r.SeenLogin("copilot", false)
	r.Fresh(context.Background(), "copilot")
	if a, _ := r.Agent("copilot"); a.LoggedIn != nil {
		t.Fatal("a new attempt (Fresh) must clear the mark")
	}
}
