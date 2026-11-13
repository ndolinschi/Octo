package plugins_test

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
	subscriptionagents "github.com/ndolinschi/Octo/apps/harness/plugins-examples/subscription-agents"
)

func builtinAgent(t *testing.T, id string) plugins.Agent {
	t.Helper()
	reg := plugins.Load(context.Background(), t.TempDir(), nil, nil, plugins.WithBuiltin(subscriptionagents.Manifest))
	a, ok := reg.Agent(id)
	if !ok {
		t.Fatalf("no built-in agent %q", id)
	}
	return a
}

// The built-in Grok pattern is defensive: one id per line, headings and the
// "not authenticated" text are ignored. The real `grok models` output is
// unverified, so these are samples of plausible shapes.
func TestBuiltinGrokModelsPattern(t *testing.T) {
	mc := builtinAgent(t, "grok").ModelsCommand
	if mc == nil || mc.Command == "" || !slices.Equal(mc.Args, []string{"models"}) {
		t.Fatalf("grok modelsCommand = %+v", mc)
	}
	for name, tc := range map[string]struct {
		out  string
		want []string
	}{
		"plain ids":         {"grok-4\ngrok-code-fast-1\n", []string{"grok-4", "grok-code-fast-1"}},
		"bullets and notes": {"Available models:\n  - grok-4 (default)\n  * grok-code-fast-1   fast, cheap\n", []string{"grok-4", "grok-code-fast-1"}},
		"crlf and indent":   {"Models\r\n    grok-3-mini\r\n", []string{"grok-3-mini"}},
		"not authenticated": {"You are not authenticated.\nRun `grok login` to sign in.\n", nil},
		"headings only":     {"Models\nName Description\n", nil},
		"version line":      {"grok 1.0.77\n", nil},
		"empty":             {"", nil},
	} {
		t.Run(name, func(t *testing.T) {
			var got []string
			for _, m := range mc.ParseModels(tc.out) {
				got = append(got, m.ID)
			}
			if !slices.Equal(got, tc.want) {
				t.Fatalf("ParseModels = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestBuiltinClaudeCodeAliases(t *testing.T) {
	a := builtinAgent(t, "claude-code")
	if !slices.Equal(a.Models, []string{"opus", "sonnet", "haiku"}) || a.ModelLabels["opus"] != "Opus" || a.ModelLabels["haiku"] != "Haiku" ||
		!strings.Contains(a.ModelsNote, "unverified") {
		t.Fatalf("claude-code = models %v labels %v note %q", a.Models, a.ModelLabels, a.ModelsNote)
	}
	if a.Roles["fast"] != "haiku" || a.Roles["balanced"] != "sonnet" || a.Roles["deep"] != "opus" {
		t.Fatalf("roles = %v", a.Roles)
	}
	for _, id := range []string{"copilot", "codex", "grok"} {
		if got := builtinAgent(t, id); len(got.Models) != 0 || len(got.Roles) != 0 {
			t.Errorf("%s lists models %v / roles %v: nothing is invented without a source", id, got.Models, got.Roles)
		}
	}
	// Documented logged-out statuses of the probes that have one.
	if a.ProbeNotLoggedInExit == nil || a.ProbeNotLoggedInExit[0] != 1 {
		t.Fatalf("claude-code notLoggedInExit = %v", a.ProbeNotLoggedInExit)
	}
	if g := builtinAgent(t, "grok"); len(g.ProbeNotLoggedInExit) != 0 || g.ProbeNotLoggedIn == nil {
		t.Fatalf("grok: only its pattern says logged out, got exits %v", g.ProbeNotLoggedInExit)
	}
}

func TestModelsCommandRun(t *testing.T) {
	dir := t.TempDir()
	script := func(name, body string) *plugins.ModelsCommand {
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, []byte("#!/bin/sh\n"+body+"\n"), 0o755); err != nil {
			t.Fatal(err)
		}
		a := builtinAgent(t, "grok")
		mc := *a.ModelsCommand
		mc.Command, mc.Args = path, nil
		return &mc
	}
	ctx := context.Background()
	got, err := script("ok.sh", "printf 'grok-4\\ngrok-4\\nnoise\\n'").Run(ctx, nil)
	if err != nil || len(got) != 1 || got[0].ID != "grok-4" {
		t.Fatalf("ok: %+v %v", got, err)
	}
	// Some CLIs print the list and still exit non-zero.
	if got, err := script("nz.sh", "echo grok-4; exit 2").Run(ctx, nil); err != nil || len(got) != 1 {
		t.Fatalf("non-zero with models: %+v %v", got, err)
	}
	if _, err := script("fail.sh", "echo boom; exit 2").Run(ctx, nil); err == nil || strings.Contains(err.Error(), "boom") {
		t.Fatalf("failure must be an error that does not quote the output: %v", err)
	}
	if _, err := script("none.sh", "echo 'You are not authenticated.'").Run(ctx, nil); err == nil {
		t.Fatal("no model recognised must be an error")
	}
	// The environment is the child allow-list plus the manifest's env.
	t.Setenv("OCTO_SECRET_TOKEN", "grok-leak")
	t.Setenv("OCTO_PLAIN", "grok-plain")
	got, err = script("env.sh", `echo "grok-seen-${OCTO_SECRET_TOKEN:-none}"; echo "grok-extra-${OCTO_EXTRA:-none}"; echo "grok-plain-${OCTO_PLAIN:-none}"`).
		Run(ctx, map[string]string{"OCTO_EXTRA": "yes"})
	if err != nil || len(got) != 3 || got[0].ID != "grok-seen-none" || got[1].ID != "grok-extra-yes" || got[2].ID != "grok-plain-none" {
		t.Fatalf("env: %+v %v", got, err)
	}
	// Output is capped: a flood of lines does not exhaust memory or the id list.
	flood, err := script("flood.sh", `i=0; while [ $i -lt 5000 ]; do echo "grok-m$i"; i=$((i+1)); done`).Run(ctx, nil)
	if err != nil || len(flood) != 100 {
		t.Fatalf("flood: %d models, %v", len(flood), err)
	}
	// A cancelled context ends it.
	cctx, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := script("slow.sh", "sleep 5").Run(cctx, nil); err == nil {
		t.Fatal("cancelled context must fail")
	}
}

func TestManifestModelFieldsAreValidated(t *testing.T) {
	for name, tc := range map[string]struct{ agent, want string }{
		"bad pattern":        {`"modelsCommand":{"command":["x"],"pattern":"("}`, "modelsCommand.pattern"},
		"no capture group":   {`"modelsCommand":{"command":["x"],"pattern":"grok"}`, "capture group"},
		"label group range":  {`"modelsCommand":{"command":["x"],"pattern":"(a)","labelGroup":2}`, "labelGroup"},
		"empty command":      {`"modelsCommand":{"command":[],"pattern":"(a)"}`, "must name a command"},
		"role tier":          {`"roles":{"huge":"a"}`, "fast, balanced, deep"},
		"role model":         {`"roles":{"fast":"has space"}`, "not a valid model name"},
		"label not listed":   {`"models":["a"],"modelLabels":{"b":"B"}`, "not in models"},
		"exit without probe": {`"auth":{"hint":"h","notLoggedInExit":[1]}`, "needs a probe"},
	} {
		t.Run(name, func(t *testing.T) {
			dir := writePlugin(t, t.TempDir(), "p", `{"name":"p","version":"1","agents":[{"id":"a","command":"sh",`+tc.agent+`}]}`)
			reg := plugins.Load(context.Background(), t.TempDir(), []string{dir}, nil)
			ps := reg.Plugins()
			if len(ps) != 1 || len(ps[0].Errors) != 1 || !strings.Contains(ps[0].Errors[0], tc.want) {
				t.Fatalf("errors = %+v, want %q", ps, tc.want)
			}
		})
	}
	// And a good one loads.
	dir := writePlugin(t, t.TempDir(), "p", `{"name":"p","version":"1","agents":[{"id":"a","command":"sh","models":["m"],"modelLabels":{"m":"M"},`+
		`"modelsNote":" n ","roles":{"fast":"m","deep":""},"modelsCommand":{"command":["sh","-c","echo m"],"pattern":"^(m)$"}}]}`)
	a, ok := plugins.Load(context.Background(), t.TempDir(), []string{dir}, nil).Agent("a")
	if !ok || a.ModelLabels["m"] != "M" || a.ModelsNote != "n" || a.Roles["fast"] != "m" || a.ModelsCommand == nil || a.ModelsCommand.Command == "" {
		t.Fatalf("agent = %+v", a)
	}
}
