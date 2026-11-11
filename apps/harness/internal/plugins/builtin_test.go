package plugins_test

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
	subscriptionagents "github.com/ndolinschi/Octo/apps/harness/plugins-examples/subscription-agents"
)

func TestBuiltinSubscriptionAgentsLoad(t *testing.T) {
	reg := plugins.Load(context.Background(), t.TempDir(), nil, nil, plugins.WithBuiltin(subscriptionagents.Manifest))
	ps := reg.Plugins()
	if len(ps) != 1 || ps[0].Name != subscriptionagents.Name || !ps[0].Builtin || len(ps[0].Errors) != 0 {
		t.Fatalf("plugins = %+v", ps)
	}
	if _, ok := reg.Agent("claude-code"); !ok || len(ps[0].Agents) != 11 {
		t.Fatalf("agents = %d", len(ps[0].Agents))
	}
	raw, err := json.Marshal(ps[0])
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	_ = json.Unmarshal(raw, &m)
	if m["builtin"] != true {
		t.Fatalf("json = %s, want builtin:true", raw)
	}
}

// The embedded manifest is the file on disk, not a copy.
func TestBuiltinManifestIsTheExampleFile(t *testing.T) {
	disk := plugins.Load(context.Background(), t.TempDir(), []string{filepath.Join("..", "..", "plugins-examples", "subscription-agents")}, nil)
	emb := plugins.Load(context.Background(), t.TempDir(), nil, nil, plugins.WithBuiltin(subscriptionagents.Manifest))
	a, b := disk.Agents(), emb.Agents()
	if len(a) != len(b) || len(a) == 0 {
		t.Fatalf("disk %d agents, embedded %d", len(a), len(b))
	}
	for i := range a {
		if a[i].ID != b[i].ID || a[i].Command != b[i].Command && filepath.Base(a[i].Command) != filepath.Base(b[i].Command) {
			t.Fatalf("agent %d differs: %+v vs %+v", i, a[i], b[i])
		}
	}
	if p := disk.Plugins()[0]; p.Builtin {
		t.Fatal("a directory plugin is not built in")
	}
}

func TestBuiltinOffWithoutTheOption(t *testing.T) {
	reg := plugins.Load(context.Background(), t.TempDir(), nil, nil)
	if len(reg.Plugins()) != 0 || len(reg.Agents()) != 0 {
		t.Fatalf("plugins = %+v", reg.Plugins())
	}
}

func TestDirectoryPluginOfTheSameNameOverridesBuiltin(t *testing.T) {
	data := t.TempDir()
	writePlugin(t, filepath.Join(data, "plugins"), "mine", `{"name":"subscription-agents","version":"9.9",
	  "agents":[{"id":"only-mine","command":"sh"}]}`)
	reg := plugins.Load(context.Background(), data, nil, nil, plugins.WithBuiltin(subscriptionagents.Manifest))
	ps := reg.Plugins()
	if len(ps) != 1 {
		t.Fatalf("plugins = %+v", ps)
	}
	p := ps[0]
	if p.Builtin || p.Version != "9.9" || len(p.Errors) != 0 || len(p.Agents) != 1 || p.Agents[0].ID != "only-mine" {
		t.Fatalf("plugin = %+v", p)
	}
	if _, ok := reg.Agent("claude-code"); ok {
		t.Fatal("the built-in agents must be gone when overridden")
	}
}

func TestDirectoryPluginInExtraDirOverridesBuiltin(t *testing.T) {
	extra := t.TempDir()
	dir := writePlugin(t, extra, "x", `{"name":"subscription-agents","version":"2","agents":[{"id":"x1","command":"sh"}]}`)
	reg := plugins.Load(context.Background(), t.TempDir(), []string{dir}, nil, plugins.WithBuiltin(subscriptionagents.Manifest))
	if ps := reg.Plugins(); len(ps) != 1 || ps[0].Builtin || ps[0].Version != "2" {
		t.Fatalf("plugins = %+v", ps)
	}
}

// A different plugin that already owns an agent id wins it quietly: the
// built-in one is skipped, with no error on either plugin.
func TestBuiltinAgentIDClashIsSilent(t *testing.T) {
	data := t.TempDir()
	writePlugin(t, filepath.Join(data, "plugins"), "custom", `{"name":"custom","version":"1","agents":[{"id":"claude-code","command":"sh"}]}`)
	reg := plugins.Load(context.Background(), data, nil, nil, plugins.WithBuiltin(subscriptionagents.Manifest))
	ps := reg.Plugins()
	if len(ps) != 2 {
		t.Fatalf("plugins = %+v", ps)
	}
	for _, p := range ps {
		if len(p.Errors) != 0 {
			t.Errorf("%s has errors %v", p.Name, p.Errors)
		}
	}
	ag, _ := reg.Agent("claude-code")
	if ag.Command == "" || filepath.Base(ag.Command) != "sh" {
		t.Fatalf("claude-code = %+v, want the custom plugin's", ag)
	}
	if ps[1].Name != subscriptionagents.Name || len(ps[1].Agents) != 10 {
		t.Fatalf("builtin = %+v", ps[1])
	}
}

// flatRate choices of the built-in subscription-agents entries (documented in
// the plugin README): agents that front arbitrary providers or forward a
// per-token key by default are not flat-rate; Grok and Claude Code are, until their
// billingEnv key (XAI_API_KEY, ANTHROPIC_API_KEY) is in the environment they get.
func TestBuiltinFlatRateChoices(t *testing.T) {
	reg := plugins.Load(context.Background(), t.TempDir(), nil, nil, plugins.WithBuiltin(subscriptionagents.Manifest))
	want := map[string]bool{
		"claude-code": true, "copilot": true, "codex": true, "cursor": true, "antigravity": true, "devin": true,
		"grok": true, "opencode": false, "droid": false, "omp": false, "pi": false,
	}
	for _, a := range reg.Agents() {
		if w, ok := want[a.ID]; !ok || a.FlatRate != w {
			t.Errorf("agent %s flat_rate = %v, want %v (listed %v)", a.ID, a.FlatRate, w, ok)
		}
		delete(want, a.ID)
	}
	if len(want) != 0 {
		t.Errorf("agents missing: %v", want)
	}
}

// The owner's default routing strengths of the built-in entries; a copied
// manifest may change them.
func TestBuiltinStrengths(t *testing.T) {
	reg := plugins.Load(context.Background(), t.TempDir(), nil, nil, plugins.WithBuiltin(subscriptionagents.Manifest))
	want := map[string][]string{
		"claude-code": {"easy", "medium", "hard"}, "codex": {"easy", "medium", "hard"},
		"copilot": {"easy", "medium"}, "cursor": {"easy", "medium"},
	}
	for _, a := range reg.Agents() {
		if w := want[a.ID]; fmt.Sprint(a.Strengths) != fmt.Sprint(w) && !(len(w) == 0 && len(a.Strengths) == 0) {
			t.Errorf("agent %s strengths = %v, want %v", a.ID, a.Strengths, w)
		}
	}
}

// pi's hint says "Needs pi on PATH": it requires it. The npx-run adapters of
// Claude Code and Codex carry no requires (see the plugin README).
func TestBuiltinRequires(t *testing.T) {
	bin := t.TempDir()
	if err := os.WriteFile(filepath.Join(bin, "npx"), []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin)
	reg := plugins.Load(context.Background(), t.TempDir(), nil, nil, plugins.WithBuiltin(subscriptionagents.Manifest))
	if cc, _ := reg.Agent("claude-code"); !cc.Available || cc.UnavailableReason != "" {
		t.Fatalf("claude-code = %+v", cc)
	}
	pi, ok := reg.Agent("pi")
	if !ok || pi.Available || !strings.Contains(pi.UnavailableReason, `"pi"`) {
		t.Fatalf("pi = %+v", pi)
	}
}

// R1.3: the three agents the owner uses come first, each with install and login text.
func TestBuiltinFirstThreeAgentsHaveInstallAndLoginText(t *testing.T) {
	reg := plugins.Load(context.Background(), t.TempDir(), nil, nil, plugins.WithBuiltin(subscriptionagents.Manifest))
	got := reg.Agents()
	for i, id := range []string{"claude-code", "copilot", "grok"} {
		if got[i].ID != id {
			t.Fatalf("agent %d = %s, want %s", i, got[i].ID, id)
		}
		if got[i].InstallHint == "" || got[i].Hint == "" {
			t.Errorf("%s: install %q, login %q", id, got[i].InstallHint, got[i].Hint)
		}
	}
	for id, want := range map[string][]string{
		"claude-code": {"/login", "npm install -g @anthropic-ai/claude-code"},
		"copilot":     {"/login", "COPILOT_GITHUB_TOKEN", "Copilot Requests", "npm install -g @github/copilot"},
		"grok":        {"grok login", "XAI_API_KEY", "per-token billing"},
	} {
		a, _ := reg.Agent(id)
		text := a.Hint + " " + a.InstallHint
		for _, w := range want {
			if !strings.Contains(text, w) {
				t.Errorf("%s: install+login text lacks %q: %s", id, w, text)
			}
		}
	}
}
