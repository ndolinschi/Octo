package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// Doctor lists every stored account as an agent of its own, probes it with its
// own environment, prints the folder and the variable names (never a value),
// and leaves the accounts file as it found it.
func TestDoctorProbesEveryAccountWithItsOwnEnv(t *testing.T) {
	data, plug := t.TempDir(), filepath.Join(t.TempDir(), "plugins", "acc")
	folder := filepath.Join(data, "accounts", "cc", "work")
	for _, d := range []string{plug, folder} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	manifest := `{"name":"acc","version":"1","agents":[{"id":"cc","label":"Claude Code","command":"sh",
	 "accounts":{"env":"CLAUDE_CONFIG_DIR"},
	 "auth":{"probe":["sh","-c","test -f \"$CLAUDE_CONFIG_DIR/ok\""],"notLoggedInExit":[1],"hint":"x"}}]}`
	store := `{"accounts":[{"id":"work","agent":"cc","label":"Work","config_dir":"` + folder + `","owned":true}]}`
	storePath := filepath.Join(data, "agent-accounts.json")
	for p, c := range map[string]string{filepath.Join(plug, "plugin.json"): manifest, storePath: store, filepath.Join(folder, "ok"): ""} {
		if err := os.WriteFile(p, []byte(c), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	run := func(extra string) string {
		cmd := exec.Command(os.Args[0], "-test.run=^TestHelperDoctor$")
		cmd.Env = []string{
			"HARNESS_TEST_HELPER_DOCTOR=1", "HARNESS_NO_BUILTIN_PLUGINS=1", "PATH=/bin:/usr/bin",
			"HARNESS_TEST_ARGS=--data-dir " + data + " --plugins-dir " + filepath.Dir(plug) + extra,
		}
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("doctor: %v\n%s", err, out)
		}
		return string(out)
	}
	text := run(" --json")
	var rep struct {
		Agents []struct {
			ID           string `json:"id"`
			Label        string `json:"label"`
			AccountOf    string `json:"account_of"`
			AccountLabel string `json:"account_label"`
			AccountDir   string `json:"account_dir"`
			Probe        struct {
				LoggedIn *bool    `json:"logged_in"`
				EnvNames []string `json:"env_names"`
			} `json:"probe"`
		} `json:"agents"`
	}
	if err := json.NewDecoder(strings.NewReader(text[strings.Index(text, "{"):])).Decode(&rep); err != nil {
		t.Fatalf("json: %v\n%s", err, text)
	}
	byID := map[string]int{}
	for i, a := range rep.Agents {
		byID[a.ID] = i
	}
	base, okBase := byID["cc"]
	work, okWork := byID["cc@work"]
	if !okBase || !okWork {
		t.Fatalf("agents = %+v", rep.Agents)
	}
	if a := rep.Agents[base]; a.Probe.LoggedIn == nil || *a.Probe.LoggedIn {
		t.Errorf("the default account reads logged in: %+v", a.Probe)
	}
	w := rep.Agents[work]
	if w.Probe.LoggedIn == nil || !*w.Probe.LoggedIn {
		t.Errorf("the account is not probed with its own folder: %+v", w.Probe)
	}
	if w.AccountOf != "cc" || w.AccountLabel != "Work" || w.AccountDir != folder {
		t.Errorf("account = %+v", w)
	}
	if !strings.Contains(strings.Join(w.Probe.EnvNames, ","), "CLAUDE_CONFIG_DIR") || strings.Contains(text, "CLAUDE_CONFIG_DIR=") {
		t.Errorf("env names = %v; a value must never be printed", w.Probe.EnvNames)
	}

	plain := run("")
	if !strings.Contains(plain, "- cc@work (Claude Code · Work)") || !strings.Contains(plain, "account: Work of cc (folder: "+folder+")") {
		t.Errorf("text report:\n%s", plain)
	}
	if after, _ := os.ReadFile(storePath); string(after) != store {
		t.Errorf("doctor rewrote the accounts file: %s", after)
	}
}
