package orchestrator

import (
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/acp"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

// UX-45: the mode an ACP session (orchestrator or sub-agent) is put in follows
// the project's access. Claude Code starts in "auto" and advertises "default".
func TestSessionModeTargetFollowsAccess(t *testing.T) {
	claude := []acp.SessionMode{{ID: "auto", Name: "Auto"}, {ID: "default", Name: "Default"}, {ID: "acceptEdits", Name: "Accept Edits"},
		{ID: "plan", Name: "Plan"}, {ID: "bypassPermissions", Name: "Bypass Permissions"}}
	noEdits := []acp.SessionMode{{ID: "auto"}, {ID: "default"}}
	acc := func(a string) func() string { return func() string { return a } }
	for _, c := range []struct {
		name, access, base string
		modes              []acp.SessionMode
		want               string
	}{
		{"supervised auto -> default", projectstore.AccessSupervised, "auto", claude, "default"},
		{"supervised bypass -> default", projectstore.AccessSupervised, "bypassPermissions", claude, "default"},
		{"supervised already asking", projectstore.AccessSupervised, "default", claude, "default"},
		{"supervised without an asking mode keeps base", projectstore.AccessSupervised, "auto", []acp.SessionMode{{ID: "auto"}}, "auto"},
		{"accept_edits auto -> default (harness approves edits)", projectstore.AccessAcceptEdits, "auto", claude, "default"},
		{"accept_edits acceptEdits -> default", projectstore.AccessAcceptEdits, "acceptEdits", claude, "default"},
		{"accept_edits without an asking mode -> acceptEdits", projectstore.AccessAcceptEdits, "auto", []acp.SessionMode{{ID: "auto"}, {ID: "acceptEdits"}}, "acceptEdits"},
		{"accept_edits without accept-edits -> default", projectstore.AccessAcceptEdits, "auto", noEdits, "default"},
		{"full keeps auto", projectstore.AccessFull, "auto", claude, "auto"},
		{"no advertised modes", projectstore.AccessSupervised, "", nil, ""},
	} {
		if got := sessionModeTarget(false, projectstore.ModeAgent, acc(c.access), c.modes, c.base); got != c.want {
			t.Errorf("%s: target = %q, want %q", c.name, got, c.want)
		}
	}
	if got := sessionModeTarget(true, projectstore.ModePlan, acc(projectstore.AccessFull), claude, "auto"); got != "plan" {
		t.Errorf("plan turn: target = %q, want plan", got)
	}
	read := false
	_ = sessionModeTarget(false, projectstore.ModeAgent, func() string { read = true; return "" }, nil, "")
	if read {
		t.Error("access was read although the agent advertised no modes")
	}
}
