package orchestrator

import (
	"strings"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/acp"
	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
	"github.com/ndolinschi/Octo/apps/harness/internal/usererr"
)

// mcpTransport "stdio" hands the tool server over the stdio relay although the
// agent advertises HTTP MCP (agy: HTTP servers need --process-per-session).
func TestMCPTransportStdioOverridesTheAdvertisement(t *testing.T) {
	caps := acp.Capabilities{MCPHTTP: true, MCPSSE: true, LoadSession: true}
	if got := mcpCaps(plugins.Agent{}, caps); !got.MCPHTTP {
		t.Fatal("auto must follow the advertisement")
	}
	got := mcpCaps(plugins.Agent{MCPTransport: plugins.MCPTransportStdio}, caps)
	if got.MCPHTTP || got.MCPSSE || !got.LoadSession {
		t.Fatalf("stdio: %+v", got)
	}
	o := &Orchestrator{opts: Options{MCPRelay: []string{"/usr/bin/harness", "mcp-relay"}}}
	o.bridge = "http://127.0.0.1:8790"
	servers, warn := o.mcpServers("Antigravity", got, "p1", "tok")
	if warn != nil || len(servers) != 1 || strings.Contains(string(servers[0]), `"type":"http"`) || !strings.Contains(string(servers[0]), "mcp-relay") {
		t.Fatalf("servers = %s, warn = %v", servers, warn)
	}
}

func TestSelfApprovingModesAndTheAskingMode(t *testing.T) {
	for id, want := range map[string]bool{"auto": true, "accept-edits": true, "acceptEdits": true, "bypassPermissions": true,
		"default": false, "plan": false, "ask": false} {
		if selfApproving(id) != want {
			t.Errorf("selfApproving(%q) = %v", id, !want)
		}
	}
	modes := []acp.SessionMode{{ID: "auto", Name: "Auto"}, {ID: "Default", Name: "Ask first"}}
	if got := askingMode(modes); got != "Default" {
		t.Fatalf("askingMode = %q", got)
	}
	if got := askingMode([]acp.SessionMode{{ID: "auto"}, {ID: "x", Name: "Default"}}); got != "x" {
		t.Fatalf("askingMode by name = %q", got)
	}
	if got := askingMode([]acp.SessionMode{{ID: "auto"}}); got != "" {
		t.Fatalf("no asking mode: %q", got)
	}
}

// A CLI the version check found too old is refused with its own message and
// the update line, not "not installed".
func TestTooOldAgentIsExplained(t *testing.T) {
	a := plugins.Agent{ID: "antigravity", Label: "Antigravity", MinVersion: "1.5.0", VersionTooOld: true,
		Version:     plugins.VersionReport{Ran: true, Version: "1.4.12", TooOld: true, Reason: "version 1.4.12 is older than 1.5.0"},
		InstallHint: "Install it: `curl -fsSL https://antigravity.google/cli/install.sh | bash`"}
	rt := &runtime{o: &Orchestrator{opts: Options{Agents: []plugins.Agent{a}}}}
	u := rt.missingAgent("antigravity")
	if u == nil || u.Code != usererr.CodeAgentTooOld || u.Message != "Antigravity 1.4.12 is too old for Octo; it needs 1.5.0 or newer." ||
		u.Command != "curl -fsSL https://antigravity.google/cli/install.sh | bash" || u.Action != usererr.ActionRecheckProvider {
		t.Fatalf("got %+v", u)
	}
}
