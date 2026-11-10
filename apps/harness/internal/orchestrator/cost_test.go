package orchestrator_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/files"
	"github.com/ndolinschi/Octo/apps/harness/internal/mockllm"
	"github.com/ndolinschi/Octo/apps/harness/internal/orchestrator"
	"github.com/ndolinschi/Octo/apps/harness/internal/project"
	"github.com/ndolinschi/Octo/apps/harness/internal/tools"
)

// recorder keeps the body of every Messages request, then delegates to next.
type recorder struct {
	next   http.Handler
	mu     sync.Mutex
	bodies [][]byte
}

func (r *recorder) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	body, _ := io.ReadAll(req.Body)
	r.mu.Lock()
	r.bodies = append(r.bodies, body)
	r.mu.Unlock()
	req.Body = io.NopCloser(bytes.NewReader(body))
	r.next.ServeHTTP(w, req)
}

func (r *recorder) all() [][]byte {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([][]byte(nil), r.bodies...)
}

type sentRequest struct {
	Model  string `json:"model"`
	System []struct {
		Text         string          `json:"text"`
		CacheControl json.RawMessage `json:"cache_control"`
	} `json:"system"`
	Tools    []json.RawMessage `json:"tools"`
	Messages []json.RawMessage `json:"messages"`
}

func decode(t *testing.T, b []byte) sentRequest {
	t.Helper()
	var r sentRequest
	if err := json.Unmarshal(b, &r); err != nil {
		t.Fatal(err)
	}
	return r
}

func (r sentRequest) systemText() string {
	var s string
	for _, b := range r.System {
		s += b.Text
	}
	return s
}

func (r sentRequest) isOrchestrator() bool {
	return strings.Contains(strings.Join(rawStrings(r.Tools), ""), `"name":"save_note"`)
}

func rawStrings(in []json.RawMessage) []string {
	out := make([]string, len(in))
	for i, r := range in {
		out[i] = string(r)
	}
	return out
}

func TestNoteChangeOnlyChangesSystemTail(t *testing.T) {
	rec := &recorder{next: mockllm.New(0)}
	r := newRig(t, rec)
	pid := r.project(t, 2)
	if st := r.run(t, pid, "a quick question", nil); st != "completed" {
		t.Fatalf("turn 1 = %s", st)
	}
	if _, err := r.notes.Save(context.Background(), pid, "Decision", "use sqlite, not postgres"); err != nil {
		t.Fatal(err)
	}
	if st := r.run(t, pid, "another quick question", nil); st != "completed" {
		t.Fatalf("turn 2 = %s", st)
	}
	bodies := rec.all()
	if len(bodies) != 2 {
		t.Fatalf("requests = %d, want 2", len(bodies))
	}
	first, second := decode(t, bodies[0]), decode(t, bodies[1])
	s1, s2 := first.systemText(), second.systemText()
	if s1 == s2 {
		t.Fatal("system prompt did not change after save")
	}
	const header = "\nProject notes (durable memory, re-read every turn):\n"
	i1, i2 := strings.Index(s1, header), strings.Index(s2, header)
	if i1 < 0 || i1 != i2 || s1[:i1] != s2[:i2] {
		t.Fatalf("static part changed: notes header at %d and %d", i1, i2)
	}
	if !strings.Contains(s1[:i1], "How you work:") {
		t.Error("instructions must precede the notes so a note change cannot invalidate them")
	}
	if !strings.Contains(s2[i2:], "### Decision\nuse sqlite, not postgres") || strings.Contains(s1, "Decision") {
		t.Errorf("notes tail wrong:\nfirst: %q\nsecond: %q", s1[i1:], s2[i2:])
	}
	if !bytes.Equal(mustJSON(t, first.Tools), mustJSON(t, second.Tools)) {
		t.Error("tool definitions changed with a note")
	}
	// The last system block carries the breakpoint; it comes after the notes, so a
	// note change costs the system block but never the tools prefix before it.
	if n := len(second.System); n == 0 || string(second.System[n-1].CacheControl) != `{"type":"ephemeral"}` {
		t.Errorf("last system block has no breakpoint: %+v", second.System)
	}
}

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// bigReports serves an orchestrator that spawns one sub-agent, which replies with
// a report of reportBytes (after optionally reading readPath).
func bigReports(reportBytes int, readPath string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		var body struct {
			Tools []struct {
				Name string `json:"name"`
			} `json:"tools"`
			Messages []json.RawMessage `json:"messages"`
		}
		_ = json.NewDecoder(req.Body).Decode(&body)
		orch := false
		for _, tl := range body.Tools {
			orch = orch || tl.Name == "save_note"
		}
		w.Header().Set("Content-Type", "application/json")
		reply := func(stop, content string) {
			fmt.Fprintf(w, `{"id":"m","type":"message","role":"assistant","model":"x","stop_reason":%q,"content":[%s],"usage":{"input_tokens":1,"output_tokens":1}}`, stop, content)
		}
		switch {
		case orch && len(body.Messages) == 1:
			reply("tool_use", `{"type":"tool_use","id":"toolu_spawn","name":"spawn_agent","input":{"role":"Reader","title":"read","task":"read it","tier":"fast"}}`)
		case orch:
			reply("end_turn", `{"type":"text","text":"done"}`)
		case readPath != "" && len(body.Messages) == 1:
			reply("tool_use", fmt.Sprintf(`{"type":"tool_use","id":"toolu_read","name":"read_file","input":{"path":%q}}`, readPath))
		default:
			reply("end_turn", fmt.Sprintf(`{"type":"text","text":%q}`, strings.Repeat("r", reportBytes)))
		}
	})
}

// toolResult returns the text of the first tool_result in request n's last message.
func lastToolResult(t *testing.T, raw []byte) string {
	t.Helper()
	var req struct {
		Messages []struct {
			Content []struct {
				Type    string `json:"type"`
				Content any    `json:"content"`
			} `json:"content"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		t.Fatal(err)
	}
	last := req.Messages[len(req.Messages)-1]
	for _, b := range last.Content {
		if b.Type != "tool_result" {
			continue
		}
		switch c := b.Content.(type) {
		case string:
			return c
		case []any:
			var s string
			for _, p := range c {
				s += p.(map[string]any)["text"].(string)
			}
			return s
		}
	}
	t.Fatalf("no tool_result in %s", raw)
	return ""
}

func TestSubAgentReportCap(t *testing.T) {
	const full = 100 << 10
	tests := []struct {
		name   string
		limits tools.Limits
		want   int // largest allowed report text the parent sees
	}{
		{"default 32 KiB", tools.Limits{}, 32 << 10},
		{"override", tools.Limits{ReportBytes: 5000}, 5000},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			rec := &recorder{next: bigReports(full, "")}
			r := newRigWith(t, rec, orchestrator.Options{Limits: tc.limits})
			pid := r.project(t, 2)
			if st := r.run(t, pid, "go", nil); st != "completed" {
				t.Fatalf("turn = %s", st)
			}
			bodies := rec.all()
			// request 0: orchestrator; 1: sub-agent; 2: orchestrator with the report.
			var report string
			for _, b := range bodies {
				if r := decode(t, b); r.isOrchestrator() && len(r.Messages) == 3 {
					report = lastToolResult(t, b)
				}
			}
			if report == "" {
				t.Fatal("orchestrator never received the report")
			}
			if len(report) > tc.want {
				t.Fatalf("parent saw %d bytes, cap is %d", len(report), tc.want)
			}
			for _, want := range []string{"[truncated: showed the first", fmt.Sprintf("of %d bytes", full), "spawn a new sub-agent"} {
				if !strings.Contains(report, want) {
					t.Errorf("report lacks %q: ...%s", want, report[len(report)-200:])
				}
			}
			// The UI still gets the whole report.
			var stored int
			for _, a := range r.agents(t, pid) {
				if a.ParentID != nil && a.Result != nil {
					stored = len(*a.Result)
				}
			}
			if stored != full {
				t.Errorf("stored report = %d bytes, want the full %d", stored, full)
			}
		})
	}
}

func TestSubAgentReadFileIsCappedButUIFileAPIIsNot(t *testing.T) {
	const size = 300 << 10
	dir := t.TempDir()
	content := strings.Repeat("0123456789abcdef\n", size/17)
	if err := os.WriteFile(filepath.Join(dir, "big.txt"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	rec := &recorder{next: bigReports(10, "big.txt")}
	r := newRig(t, rec)
	maxDepth := 2
	name := "p"
	p, err := r.svc.Create(context.Background(), project.Input{Name: &name, MaxDepth: &maxDepth, Folders: &[]project.FolderInput{{Path: dir}}})
	if err != nil {
		t.Fatal(err)
	}
	if st := r.run(t, p.ID, "go", nil); st != "completed" {
		t.Fatalf("turn = %s", st)
	}
	var seen string
	for _, b := range rec.all() {
		if q := decode(t, b); !q.isOrchestrator() && len(q.Messages) == 3 {
			seen = lastToolResult(t, b)
		}
	}
	if seen == "" || len(seen) > tools.DefaultMaxResultBytes {
		t.Fatalf("sub-agent saw %d bytes of read_file output, want 1..%d", len(seen), tools.DefaultMaxResultBytes)
	}
	if !strings.Contains(seen, "read_file: showed lines 1-") || !strings.Contains(seen, "total") {
		t.Errorf("read_file result lacks its range footer: ...%s", seen[len(seen)-200:])
	}
	// The UI file API (and the bridge endpoints over it) is not subject to the model-context caps.
	got, _, err := files.Read(dir, "big.txt")
	if err != nil || len(got) != len(content) {
		t.Fatalf("files.Read = %d bytes, %v; want the full %d", len(got), err, len(content))
	}
	fc, err := project.NewFiles(r.store, r.hub).Read(context.Background(), p.ID, p.Folders[0].Label, "big.txt")
	if err != nil || len(fc.Content) != len(content) {
		t.Fatalf("project files Read = %d bytes, %v; want %d", len(fc.Content), err, len(content))
	}
}

func TestDefaultModelsAndStoredProjectsUntouched(t *testing.T) {
	t.Setenv("HARNESS_MODEL_ORCHESTRATOR", "")
	t.Setenv("HARNESS_MODEL_DEEP", "")
	def := config.DefaultModels()
	if def.Orchestrator != "claude-sonnet-5-5" || def.Orchestrator != def.Balanced || def.Deep != "claude-opus-5-5" || def.Fast != "claude-haiku-5-5" {
		t.Fatalf("defaults = %+v", def)
	}
	t.Setenv("HARNESS_MODEL_ORCHESTRATOR", "custom-orch")
	if got := config.DefaultModels().Orchestrator; got != "custom-orch" {
		t.Fatalf("env override = %q", got)
	}
	t.Setenv("HARNESS_MODEL_ORCHESTRATOR", "")

	rec := &recorder{next: mockllm.New(0)}
	r := newRig(t, rec)
	ctx := context.Background()
	name := "p"
	folders := &[]project.FolderInput{{Path: t.TempDir()}}

	// A project stored with the previous defaults (opus orchestrator), as an old data dir holds.
	old := def
	old.Orchestrator = "claude-opus-5-5"
	oldSvc := project.NewService(r.store, r.hub, r.orch, project.Defaults{Models: old, MaxDepth: 3})
	legacy, err := oldSvc.Create(ctx, project.Input{Name: &name, Folders: folders})
	if err != nil {
		t.Fatal(err)
	}
	fresh, err := r.svc.Create(ctx, project.Input{Name: &name, Folders: folders})
	if err != nil {
		t.Fatal(err)
	}
	if fresh.Models.Orchestrator != "claude-sonnet-5-5" {
		t.Errorf("new project orchestrator = %q, want the balanced default", fresh.Models.Orchestrator)
	}
	for _, tc := range []struct{ name, pid, want string }{
		{"stored models are kept", legacy.ID, "claude-opus-5-5"},
		{"new project uses the balanced default", fresh.ID, "claude-sonnet-5-5"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := r.svc.Get(ctx, tc.pid)
			if err != nil || got.Models.Orchestrator != tc.want {
				t.Fatalf("project models = %+v, %v; want orchestrator %s", got.Models, err, tc.want)
			}
			before := len(rec.all())
			if st := r.run(t, tc.pid, "a quick question", nil); st != "completed" {
				t.Fatalf("turn = %s", st)
			}
			if sent := decode(t, rec.all()[before]); sent.Model != tc.want {
				t.Fatalf("request model = %q, want %q", sent.Model, tc.want)
			}
		})
	}
}
