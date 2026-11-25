package bridge_test

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// openEvents reads the project's SSE stream until stop returns true for an event.
func (e *reviewEnv) untilEvent(t *testing.T, start func(), stop func(typ string, data map[string]any) bool) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", e.url+e.path("/events"), nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 0, 64<<10), 4<<20)
	started := false
	typ := ""
	for sc.Scan() {
		line := sc.Text()
		if !started && strings.HasPrefix(line, ": connected") {
			started = true
			start()
			continue
		}
		if strings.HasPrefix(line, "event: ") {
			typ = strings.TrimPrefix(line, "event: ")
		}
		if strings.HasPrefix(line, "data: ") {
			var m map[string]any
			if json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &m) == nil && stop(typ, m) {
				return
			}
		}
	}
	t.Fatalf("the event stream ended: %v", sc.Err())
}

// Project commands (decision 68): the project field, suggestions, run, runs, stop;
// in a supervised project a run is still the user's own action.
func TestCommandsAPI(t *testing.T) {
	e := newReviewEnv(t, true) // supervised
	if err := os.WriteFile(filepath.Join(e.dir, "package.json"), []byte(`{"scripts":{"dev":"vite","test":"vitest"}}`), 0o644); err != nil {
		t.Fatal(err)
	}

	// The project field: validated, replaced as a whole, returned with the project.
	if p := e.get(t, ""); p["commands"] == nil || len(p["commands"].([]any)) != 0 {
		t.Fatalf("commands of a new project = %v", p["commands"])
	}
	e.wantError(t, "PATCH", "/v1/projects/"+e.pid, map[string]any{"commands": []map[string]any{{"name": "a", "command": ""}}}, http.StatusBadRequest, "invalid_request")
	e.wantError(t, "PATCH", "/v1/projects/"+e.pid, map[string]any{"commands": []map[string]any{{"name": "a", "command": "x", "cwd": "../up"}}}, http.StatusBadRequest, "invalid_request")
	e.wantError(t, "PATCH", "/v1/projects/"+e.pid, map[string]any{"commands": []map[string]any{{"name": "a", "command": "x"}, {"name": "A", "command": "y"}}}, http.StatusBadRequest, "invalid_request")
	var p map[string]any
	e.into(t, "PATCH", "/v1/projects/"+e.pid, map[string]any{"commands": []map[string]any{
		{"name": "Hello", "command": "echo hi; echo err >&2; exit 2", "pinned": true},
		{"name": "Sleep", "command": "sleep 300"},
		{"name": "test", "command": "pnpm test"},
	}}, http.StatusOK, &p)
	cmds := p["commands"].([]any)
	if len(cmds) != 3 || cmds[0].(map[string]any)["name"] != "Hello" || cmds[0].(map[string]any)["pinned"] != true {
		t.Fatalf("commands = %v", cmds)
	}
	// A patch without commands leaves them.
	e.into(t, "PATCH", "/v1/projects/"+e.pid, map[string]any{"description": "d"}, http.StatusOK, &p)
	if len(p["commands"].([]any)) != 3 {
		t.Fatalf("commands after another patch = %v", p["commands"])
	}

	// Suggestions: names and command lines, marked when already configured; nothing runs.
	sg := e.get(t, "/commands/suggestions")["suggestions"].([]any)
	if len(sg) != 2 {
		t.Fatalf("suggestions = %v", sg)
	}
	first := sg[0].(map[string]any)
	mustHave(t, "suggestion", first, "name", "command", "cwd", "source", "configured")
	if first["name"] != "dev" || first["command"] != "npm run dev" || first["source"] != "package.json" || first["configured"] != false ||
		sg[1].(map[string]any)["configured"] != true {
		t.Fatalf("suggestions = %v", sg)
	}

	// Run: {run_id}, output events, finished with the exit code. No approval card in a supervised project.
	var run map[string]any
	var out strings.Builder
	var finished map[string]any
	e.untilEvent(t, func() {
		e.into(t, "POST", e.path("/commands/hello/run"), nil, http.StatusCreated, &run)
	}, func(typ string, d map[string]any) bool {
		switch typ {
		case "command.output":
			if d["run_id"] == run["run_id"] {
				out.WriteString(d["stream"].(string) + ":" + d["text"].(string))
			}
		case "command.finished":
			if d["run_id"] == run["run_id"] {
				finished = d
				return true
			}
		}
		return false
	})
	if !strings.Contains(out.String(), "stdout:hi\n") || !strings.Contains(out.String(), "stderr:err\n") {
		t.Fatalf("output = %q", out.String())
	}
	if finished["exit_code"].(float64) != 2 || finished["duration_ms"] == nil || finished["status"] != "finished" {
		t.Fatalf("finished = %v", finished)
	}
	mustHave(t, "run", run["run"].(map[string]any), "id", "name", "command", "cwd", "status", "started_at", "duration_ms", "output_bytes", "truncated")
	var approvals map[string]any
	e.into(t, "GET", e.path("/approvals"), nil, http.StatusOK, &approvals)
	if len(approvals["approvals"].([]any)) != 0 {
		t.Fatalf("a run asked for an approval: %v", approvals)
	}

	// GET run: status and tail; GET runs: the list without tails.
	got := e.get(t, "/runs/"+run["run_id"].(string))
	if got["status"] != "finished" || got["exit_code"].(float64) != 2 || !strings.Contains(got["tail"].(string), "hi") || got["name"] != "Hello" {
		t.Fatalf("run = %v", got)
	}
	list := e.get(t, "/runs")["runs"].([]any)
	if len(list) != 1 || list[0].(map[string]any)["tail"] != nil {
		t.Fatalf("runs = %v", list)
	}

	// Stop: a long run ends as stopped.
	var slow map[string]any
	e.into(t, "POST", e.path("/commands/Sleep/run"), nil, http.StatusCreated, &slow)
	if g := e.get(t, "/runs/"+slow["run_id"].(string)); g["status"] != "running" || g["exit_code"] != nil {
		t.Fatalf("running run = %v", g)
	}
	var stopped map[string]any
	e.into(t, "POST", e.path("/runs/"+slow["run_id"].(string)+"/stop"), nil, http.StatusOK, &stopped)
	if stopped["status"] != "stopped" || stopped["exit_code"] == nil {
		t.Fatalf("stopped = %v", stopped)
	}

	// A run tied to a review is listed in its metadata.
	var rv map[string]any
	e.into(t, "POST", e.path("/reviews"), map[string]any{"pr": 1}, http.StatusCreated, &rv)
	rid := rv["id"].(string)
	var rrun map[string]any
	e.untilEvent(t, func() {
		e.into(t, "POST", e.path("/commands/Hello/run"), map[string]any{"review_id": rid}, http.StatusCreated, &rrun)
	}, func(typ string, d map[string]any) bool {
		return typ == "command.finished" && d["run_id"] == rrun["run_id"] && d["review_id"] == rid
	})
	if r := rrun["run"].(map[string]any); r["review_id"] != rid || r["cwd"] != rv["worktree_path"] {
		t.Fatalf("review run = %v", r)
	}
	runs := e.get(t, "/reviews/"+rid)["meta"].(map[string]any)["runs"].([]any)
	if len(runs) != 1 {
		t.Fatalf("review meta.runs = %v", runs)
	}
	ref := runs[0].(map[string]any)
	mustHave(t, "run ref", ref, "id", "name", "status", "exit_code", "started_at", "finished_at")
	if ref["name"] != "Hello" || ref["exit_code"].(float64) != 2 || ref["finished_at"] == "" {
		t.Fatalf("run ref = %v", ref)
	}
	if n := len(e.get(t, "/runs?review_id="+rid)["runs"].([]any)); n != 1 {
		t.Fatalf("runs of the review = %d", n)
	}

	// Errors.
	e.wantError(t, "POST", e.path("/commands/nope/run"), nil, http.StatusNotFound, "command_not_found")
	e.wantError(t, "GET", e.path("/runs/run_nope"), nil, http.StatusNotFound, "not_found")
	e.wantError(t, "POST", e.path("/commands/Hello/run"), map[string]any{"review_id": "rev_nope"}, http.StatusNotFound, "review_not_found")
	e.wantError(t, "GET", e.path("/runs?limit=0"), nil, http.StatusBadRequest, "invalid_request")
	e.wantError(t, "POST", e.path("/commands/Hello/run"), "not json", http.StatusBadRequest, "invalid_request")
}

// Review configuration per project (RV1.5): the project field, validation, and what the review returns.
func TestProjectReviewConfigAPI(t *testing.T) {
	e := newReviewEnv(t, false)
	p := e.get(t, "")
	def, _ := p["review"].(map[string]any)
	if def["prefer"] != "auto" || len(def["commands"].([]any)) != 0 || len(def["mechanical_globs"].([]any)) != 0 {
		t.Fatalf("default review config = %v", def)
	}
	for _, bad := range []map[string]any{{"prefer": "wide"}, {"commands": []string{""}}, {"mechanical_globs": []string{"!x"}}} {
		e.wantError(t, "PATCH", "/v1/projects/"+e.pid, map[string]any{"review": bad}, http.StatusBadRequest, "invalid_request")
	}
	e.into(t, "PATCH", "/v1/projects/"+e.pid, map[string]any{"review": map[string]any{"commands": []string{"Tests"}, "mechanical_globs": []string{"*.md"}, "prefer": "split"}}, http.StatusOK, &p)
	if r := p["review"].(map[string]any); r["prefer"] != "split" || r["mechanical_globs"].([]any)[0] != "*.md" {
		t.Fatalf("review = %v", r)
	}
	// A patch without review leaves it.
	e.into(t, "PATCH", "/v1/projects/"+e.pid, map[string]any{"description": "d"}, http.StatusOK, &p)
	if p["review"].(map[string]any)["prefer"] != "split" {
		t.Fatalf("review after another patch = %v", p["review"])
	}
	var rv map[string]any
	e.into(t, "POST", e.path("/reviews"), map[string]any{"pr": 1}, http.StatusCreated, &rv)
	cfg := rv["config"].(map[string]any)
	if cfg["prefer"] != "split" || cfg["commands"].([]any)[0] != "Tests" {
		t.Fatalf("review.config = %v", cfg)
	}
	var files struct {
		Files []struct{ Path, Reason string } `json:"files"`
	}
	e.into(t, "GET", e.path("/reviews/"+rv["id"].(string)+"/files"), nil, http.StatusOK, &files)
	found := false
	for _, f := range files.Files {
		if f.Path == "README.md" {
			found = f.Reason == "configured"
		}
	}
	if !found {
		t.Fatalf("README.md is not folded as configured: %v", files.Files)
	}
	// A review object replaces the configuration as a whole: the rest takes its defaults.
	e.into(t, "PATCH", "/v1/projects/"+e.pid, map[string]any{"review": map[string]any{}}, http.StatusOK, &p)
	if p["review"].(map[string]any)["prefer"] != "auto" {
		t.Fatalf("empty review should reset to defaults: %v", p["review"])
	}
}
