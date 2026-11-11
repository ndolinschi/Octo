package review_test

import (
	"os/exec"
	"strings"
	"testing"
)

// Safety: an agent has no path to submit. Everything an agent can run (the
// orchestrator and sub-agents, their built-in and remote tools, the harness's
// MCP server and relay, ACP clients, the project service) is compiled without
// the review service and the code-host adapter: no agent-side package imports
// them, directly or through any dependency, so no tool can call Submit or
// PostReview. The only importer is the bridge's review routes (the UI's API).
func TestAgentSidePackagesCannotReachTheReviewService(t *testing.T) {
	const mod = "github.com/ndolinschi/Octo/apps/harness/internal/"
	agentSide := []string{"orchestrator", "agent", "tools/...", "mcp", "mcprelay", "acp", "plugins", "permission", "approval",
		"project", "memory", "completion", "inputs", "secrets", "lsp"}
	var args = []string{"list", "-deps", "-f", "{{.ImportPath}}"}
	for _, p := range agentSide {
		args = append(args, mod+p)
	}
	out, err := exec.Command("go", args...).CombinedOutput()
	if err != nil {
		t.Skipf("go list unavailable: %v\n%s", err, out)
	}
	deps := strings.Fields(string(out))
	if len(deps) < 20 {
		t.Fatalf("go list returned too little: %v", deps)
	}
	for _, d := range deps {
		if d == mod+"review" || d == mod+"codehost" || strings.HasPrefix(d, mod+"review/") {
			t.Fatalf("an agent-side package depends on %s", d)
		}
	}

	// And the bridge is the only package that imports the review service.
	out, err = exec.Command("go", "list", "-f", "{{.ImportPath}}: {{join .Imports \" \"}}", mod+"...").CombinedOutput()
	if err != nil {
		t.Skipf("go list unavailable: %v\n%s", err, out)
	}
	for _, line := range strings.Split(string(out), "\n") {
		pkg, imports, _ := strings.Cut(line, ": ")
		if strings.Contains(imports, mod+"review") && !strings.HasPrefix(pkg, mod+"bridge") && !strings.HasPrefix(pkg, mod+"review") {
			t.Fatalf("%s imports the review service", pkg)
		}
		if strings.Contains(imports, mod+"codehost") && !strings.HasPrefix(pkg, mod+"review") && !strings.HasPrefix(pkg, mod+"bridge") {
			t.Fatalf("%s imports the code-host adapter", pkg)
		}
	}
}
