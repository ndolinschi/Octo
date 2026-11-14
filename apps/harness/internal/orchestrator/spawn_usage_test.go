package orchestrator_test

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/orchestrator"
)

// The first call Claude Code made over MCP in the owner's live run, before it
// had loaded the tool's schema: only task and tier, the two arguments the
// briefing mentioned. The refusal must say what is missing and give a full
// example so the retry is right; plain text, no Markdown fence.
func TestSpawnRefusalNamesMissingArgumentsWithExample(t *testing.T) {
	a := runAuto(t, nil, orchestrator.Options{}, `{"task":"Count the lines of main.go. Report just the number.","tier":"fast"}`, nil)
	if !a.isErr || a.hasKids {
		t.Fatalf("result %q error=%v kids=%v: the call must be refused before a sub-agent starts", a.result, a.isErr, a.hasKids)
	}
	for _, want := range []string{
		"spawn_agent requires role, title, task and tier (fast|balanced|deep).",
		"Missing: role, title.",
		"No sub-agent was started.",
		`Example arguments: {"role": "Code explorer", "title": "Count lines of main.go", "task": `,
	} {
		if !strings.Contains(a.result, want) {
			t.Errorf("refusal lacks %q:\n%s", want, a.result)
		}
	}
	if strings.Contains(a.result, "```") || strings.Contains(a.result, "Missing: role, title, task") {
		t.Errorf("refusal = %q", a.result)
	}
	// The example itself is a valid call.
	i := strings.Index(a.result, "Example arguments: ")
	var ex map[string]string
	if err := json.Unmarshal([]byte(a.result[i+len("Example arguments: "):]), &ex); err != nil ||
		ex["role"] == "" || ex["title"] == "" || ex["task"] == "" || ex["tier"] != "fast" {
		t.Errorf("example %v (%v)", ex, err)
	}
}

func TestSpawnRefusalNamesUnknownTier(t *testing.T) {
	a := runAuto(t, nil, orchestrator.Options{}, `{"role":"W","title":"t","task":"x","tier":"medium"}`, nil)
	if !a.isErr || a.hasKids || !strings.Contains(a.result, `tier "medium" is not one of fast, balanced, deep.`) ||
		strings.Contains(a.result, "Missing:") {
		t.Fatalf("result %q error=%v kids=%v", a.result, a.isErr, a.hasKids)
	}
}

// prompt and description (the names of Claude Code's own Task tool) stand in
// for task and title.
func TestSpawnAcceptsPromptAndDescriptionAliases(t *testing.T) {
	a := runAuto(t, nil, orchestrator.Options{}, `{"role":"Worker","description":"Count lines","prompt":"Count the lines of main.go.","tier":"fast"}`, nil)
	if a.isErr || !a.hasKids {
		t.Fatalf("result %q error=%v kids=%v", a.result, a.isErr, a.hasKids)
	}
	if a.child.Title != "Count lines" || a.child.Task != "Count the lines of main.go." || a.child.Role != "Worker" {
		t.Fatalf("child = %+v", a.child)
	}
	// The canonical names win when both are given.
	b := runAuto(t, nil, orchestrator.Options{}, `{"role":"Worker","title":"T","description":"D","task":"K","prompt":"P","tier":"fast"}`, nil)
	if b.isErr || b.child.Title != "T" || b.child.Task != "K" {
		t.Fatalf("result %q, child = %+v", b.result, b.child)
	}
}
