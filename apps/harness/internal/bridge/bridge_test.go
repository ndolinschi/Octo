package bridge_test

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/bridge"
	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/project"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

func TestFullTurnOverHTTP(t *testing.T) {
	gate := make(chan struct{})
	e := newEnv(t, gate)
	folder := t.TempDir()
	if err := os.WriteFile(filepath.Join(folder, "README.md"), []byte("# demo"), 0o644); err != nil {
		t.Fatal(err)
	}

	var proj project.Project
	e.into(t, "POST", "/v1/projects", map[string]any{
		"name": "Demo", "description": "d", "folders": []map[string]string{{"path": folder}},
	}, http.StatusCreated, &proj)
	if proj.Status != "idle" || len(proj.Folders) != 1 || proj.Folders[0].Label != filepath.Base(folder) || proj.MaxDepth != 3 {
		t.Fatalf("project = %+v", proj)
	}
	pid := proj.ID
	stream := e.subscribe(t, pid)

	var posted struct{ Message projectstore.Message }
	e.into(t, "POST", "/v1/projects/"+pid+"/messages", map[string]string{"text": "Add retry logic to the fetch helper"}, http.StatusAccepted, &posted)
	if posted.Message.Role != "user" || len(posted.Message.Content) != 1 {
		t.Fatalf("posted message = %+v", posted.Message)
	}

	// v7: a message sent while a turn runs is queued (it used to be refused with 409 turn_in_progress);
	// it is removed again here so the rest of this test sees one turn.
	var queued struct{ Queued projectstore.QueuedMessage }
	e.into(t, "POST", "/v1/projects/"+pid+"/messages", map[string]string{"text": "again"}, http.StatusAccepted, &queued)
	if queued.Queued.ID == "" || queued.Queued.Text != "again" {
		t.Fatalf("queued = %+v", queued)
	}
	e.into(t, "DELETE", "/v1/projects/"+pid+"/queue/"+queued.Queued.ID, nil, http.StatusNoContent, nil)
	e.wantError(t, "DELETE", "/v1/projects/"+pid, nil, http.StatusConflict, "turn_in_progress")
	var running project.Summary
	e.into(t, "GET", "/v1/projects/"+pid, nil, http.StatusOK, &running)
	if running.Status != "running" {
		t.Fatalf("status during turn = %s", running.Status)
	}
	close(gate)

	evs := collectUntilTurnFinished(t, stream)
	assertEvents(t, evs)

	var agents struct{ Agents []projectstore.Agent }
	e.into(t, "GET", "/v1/projects/"+pid+"/agents", nil, http.StatusOK, &agents)
	assertTree(t, pid, agents.Agents)

	orch := agents.Agents[0]
	var msgs struct{ Messages []projectstore.Message }
	e.into(t, "GET", "/v1/projects/"+pid+"/agents/"+orch.ID+"/messages", nil, http.StatusOK, &msgs)
	assertOrchestratorMessages(t, msgs.Messages)

	child := agents.Agents[1]
	var childMsgs struct{ Messages []projectstore.Message }
	e.into(t, "GET", "/v1/projects/"+pid+"/agents/"+child.ID+"/messages", nil, http.StatusOK, &childMsgs)
	if len(childMsgs.Messages) < 3 || childMsgs.Messages[0].Role != "user" ||
		*childMsgs.Messages[0].Content[0].Text != child.Task {
		t.Fatalf("child transcript = %+v", childMsgs.Messages)
	}

	var notes struct{ Notes []projectstore.Note }
	e.into(t, "GET", "/v1/projects/"+pid+"/notes", nil, http.StatusOK, &notes)
	if len(notes.Notes) != 1 || notes.Notes[0].Title != "Current goal" || notes.Notes[0].Author != "orchestrator" {
		t.Fatalf("notes = %+v", notes.Notes)
	}

	e.into(t, "GET", "/v1/projects", nil, http.StatusOK, &struct{ Projects []project.Summary }{})
	e.wantError(t, "POST", "/v1/projects/"+pid+"/agents/"+orch.ID+"/messages", map[string]string{"text": "x"}, http.StatusNotFound, "not_found")
	e.wantError(t, "POST", "/v1/projects/"+pid+"/agents/"+child.ID+"/messages", map[string]string{"text": "x"}, http.StatusNotFound, "not_found")
}

func assertEvents(t *testing.T, evs []sseEvent) {
	t.Helper()
	if n := count(evs, events.AgentCreated); n != 4 {
		t.Errorf("agent.created = %d, want 4 (3 children + 1 nested)", n)
	}
	for _, typ := range []string{events.MessageDelta, events.MessageCreated, events.ToolStarted, events.ToolFinished, events.AgentUpdated, events.NoteChanged} {
		if count(evs, typ) == 0 {
			t.Errorf("no %s events", typ)
		}
	}
	last := evs[len(evs)-1]
	if last.Data["status"] != "completed" || last.Data["error"] != nil {
		t.Errorf("turn.finished = %+v", last.Data)
	}
	var prev float64
	for _, ev := range evs {
		seq, _ := ev.Data["seq"].(float64)
		if seq <= prev || ev.ID == "" {
			t.Fatalf("seq not strictly increasing: %v after %v (id %q)", seq, prev, ev.ID)
		}
		prev = seq
	}
}

func assertTree(t *testing.T, pid string, agents []projectstore.Agent) {
	t.Helper()
	if len(agents) != 5 {
		t.Fatalf("agents = %d, want 5", len(agents))
	}
	models := config.DefaultModels()
	orch := agents[0]
	if orch.ParentID != nil || orch.Depth != 0 || orch.Role != "orchestrator" || orch.Tier != nil ||
		orch.Status != projectstore.StatusIdle || orch.Model != models.Orchestrator || orch.ProjectID != pid {
		t.Fatalf("orchestrator = %+v", orch)
	}
	want := []struct {
		role  string
		tier  projectstore.Tier
		model string
	}{
		{"Code explorer", projectstore.TierFast, models.Fast},
		{"Implementation engineer", projectstore.TierBalanced, models.Balanced},
		{"Systems architect", projectstore.TierDeep, models.Deep},
	}
	byRole := map[string]projectstore.Agent{}
	for _, a := range agents[1:] {
		byRole[a.Role] = a
	}
	for _, w := range want {
		a, ok := byRole[w.role]
		if !ok || *a.Tier != w.tier || a.Model != w.model || a.Depth != 1 || *a.ParentID != orch.ID {
			t.Fatalf("child %s = %+v", w.role, a)
		}
		if a.SpawnToolUseID == nil || !strings.HasPrefix(*a.SpawnToolUseID, "toolu_") || a.Task == "" || a.Title == "" {
			t.Fatalf("child %s spawn fields = %+v", w.role, a)
		}
	}
	nested := byRole["Risk analyst"]
	if nested.Depth != 2 || *nested.ParentID != byRole["Systems architect"].ID || *nested.Tier != projectstore.TierFast {
		t.Fatalf("nested = %+v", nested)
	}
	for _, a := range agents {
		if a.ParentID != nil && (a.Status != projectstore.StatusCompleted || a.Result == nil || a.StartedAt == nil || a.FinishedAt == nil) {
			t.Errorf("agent %s not completed cleanly: %+v", a.Role, a)
		}
		if a.InputTokens <= 0 || a.OutputTokens <= 0 {
			t.Errorf("agent %s tokens = %d/%d", a.Role, a.InputTokens, a.OutputTokens)
		}
	}
}

func assertOrchestratorMessages(t *testing.T, msgs []projectstore.Message) {
	t.Helper()
	var spawns, results int
	for _, m := range msgs {
		if len(m.Content) == 0 {
			t.Fatalf("message %d has no content blocks", m.ID)
		}
		for _, b := range m.Content {
			switch b.Type {
			case "text":
				if b.Text == nil || *b.Text == "" {
					t.Fatalf("empty text block in message %d", m.ID)
				}
			case "tool_use":
				if b.ID == nil || b.Name == nil || len(b.Input) == 0 {
					t.Fatalf("bad tool_use %+v", b)
				}
				if *b.Name == "spawn_agent" {
					spawns++
				}
			case "tool_result":
				if b.ToolUseID == nil || b.Content == nil || b.IsError == nil {
					t.Fatalf("bad tool_result %+v", b)
				}
				results++
			default:
				t.Fatalf("unexpected block type %q", b.Type)
			}
		}
	}
	last := msgs[len(msgs)-1]
	if spawns != 3 || results != 4 || last.Role != "assistant" || !strings.Contains(*last.Content[0].Text, "## Summary") {
		t.Fatalf("spawns=%d results=%d last=%+v", spawns, results, last)
	}
}

func TestValidationErrors(t *testing.T) {
	e := newEnv(t, nil)
	var p project.Project
	e.into(t, "POST", "/v1/projects", map[string]string{"name": "ok"}, http.StatusCreated, &p)
	if len(p.Folders) != 0 || p.Models.Orchestrator == "" {
		t.Fatalf("project = %+v", p)
	}
	base := "/v1/projects/" + p.ID
	for _, tc := range []struct {
		name, method, path string
		body               any
		status             int
		code               string
	}{
		{"missing name", "POST", "/v1/projects", map[string]string{}, 400, "invalid_request"},
		{"blank name", "POST", "/v1/projects", map[string]string{"name": "  "}, 400, "invalid_request"},
		{"bad depth", "POST", "/v1/projects", map[string]any{"name": "x", "max_depth": 99}, 400, "invalid_request"},
		{"relative folder", "POST", "/v1/projects", map[string]any{"name": "x", "folders": []map[string]string{{"path": "rel"}}}, 400, "invalid_request"},
		{"missing folder", "POST", "/v1/projects", map[string]any{"name": "x", "folders": []map[string]string{{"path": "/definitely/not/here"}}}, 400, "invalid_request"},
		{"bad json", "POST", "/v1/projects", "not an object", 400, "invalid_request"},
		{"empty message", "POST", base + "/messages", map[string]string{"text": " "}, 400, "invalid_request"},
		{"empty note title", "POST", base + "/notes", map[string]string{"title": ""}, 400, "invalid_request"},
		{"unknown project", "GET", "/v1/projects/nope", nil, 404, "not_found"},
		{"unknown project message", "POST", "/v1/projects/nope/messages", map[string]string{"text": "x"}, 404, "not_found"},
		{"unknown agent", "GET", base + "/agents/nope", nil, 404, "not_found"},
		{"unknown agent messages", "GET", base + "/agents/nope/messages", nil, 404, "not_found"},
		{"unknown note", "PATCH", base + "/notes/nope", map[string]string{"title": "t"}, 404, "not_found"},
		{"unknown route", "GET", "/v1/nothing", nil, 404, "not_found"},
	} {
		t.Run(tc.name, func(t *testing.T) { e.wantError(t, tc.method, tc.path, tc.body, tc.status, tc.code) })
	}
}

func TestProjectCRUDAndNotes(t *testing.T) {
	e := newEnv(t, nil)
	a, b := t.TempDir(), t.TempDir()
	var p project.Project
	e.into(t, "POST", "/v1/projects", map[string]any{
		"name": "P", "folders": []map[string]string{{"path": a, "label": "src"}},
		"models": map[string]string{"fast": "tiny"},
	}, http.StatusCreated, &p)
	if p.Models.Fast != "tiny" || p.Models.Deep != config.DefaultModels().Deep {
		t.Fatalf("models = %+v", p.Models)
	}
	base := "/v1/projects/" + p.ID
	stream := e.subscribe(t, p.ID)

	var up project.Project
	e.into(t, "PATCH", base, map[string]any{
		"name": "Renamed", "folders": []map[string]string{{"path": b}, {"path": b}}, "max_depth": 2,
	}, http.StatusOK, &up)
	if up.Name != "Renamed" || up.MaxDepth != 2 || len(up.Folders) != 2 ||
		up.Folders[0].Label == up.Folders[1].Label || up.Models.Fast != "tiny" {
		t.Fatalf("patched = %+v", up)
	}
	if ev := <-stream; ev.Type != events.ProjectUpdated && ev.Type != events.AgentUpdated {
		t.Fatalf("first event = %s", ev.Type)
	}

	var note projectstore.Note
	e.into(t, "POST", base+"/notes", map[string]string{"title": "Fact", "content": "x"}, http.StatusCreated, &note)
	e.into(t, "PATCH", base+"/notes/"+note.ID, map[string]string{"content": "y"}, http.StatusOK, &note)
	if note.Content != "y" || note.Author != "user" {
		t.Fatalf("note = %+v", note)
	}
	e.into(t, "DELETE", base+"/notes/"+note.ID, nil, http.StatusNoContent, nil)
	changed := 0
	for changed < 3 {
		select {
		case ev := <-stream:
			if ev.Type == events.NoteChanged {
				changed++
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("note.changed events = %d, want 3", changed)
		}
	}

	e.into(t, "POST", base+"/cancel", nil, http.StatusAccepted, nil)
	e.into(t, "DELETE", base, nil, http.StatusNoContent, nil)
	e.wantError(t, "GET", base, nil, http.StatusNotFound, "not_found")
}

func TestHealthConfigAndCORS(t *testing.T) {
	e := newEnv(t, nil)
	var h struct {
		OK      bool
		Version string
	}
	e.into(t, "GET", "/health", nil, http.StatusOK, &h)
	if !h.OK || h.Version == "" {
		t.Fatalf("health = %+v", h)
	}
	var cfg struct {
		DefaultModels   config.Models `json:"default_models"`
		DefaultMaxDepth int           `json:"default_max_depth"`
	}
	e.into(t, "GET", "/v1/config", nil, http.StatusOK, &cfg)
	if cfg.DefaultMaxDepth != 3 || cfg.DefaultModels.Orchestrator == "" {
		t.Fatalf("config = %+v", cfg)
	}
	// Only the UI's own origins: the desktop shell's and the dev server's (security review finding 11). Any other
	// localhost port, such as the Browser tab's proxy (http://127.0.0.1:<ephemeral>) or another local dev server, is
	// not the UI, and a dev bundle carries the API token.
	for origin, allowed := range map[string]bool{
		"http://localhost:1420": true, "http://127.0.0.1:1420": true, "tauri://localhost": true,
		"http://tauri.localhost": true, "http://127.0.0.1:5173": false, "http://127.0.0.1:43123": false,
		"http://localhost:3000": false, "http://evil.example": false, "http://localhost.evil.com": false,
	} {
		req, err := http.NewRequest(http.MethodOptions, e.url+"/v1/projects", nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Origin", origin)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		got := resp.Header.Get("Access-Control-Allow-Origin") == origin
		if got != allowed || resp.StatusCode != http.StatusNoContent {
			t.Errorf("origin %s: allowed=%v status=%d", origin, got, resp.StatusCode)
		}
	}
}

// HARNESS_UI_ORIGINS (bridge.WithUIOrigins) names the dev server's origin when it is not on the default port.
func TestConfiguredUIOrigins(t *testing.T) {
	e := newEnvWith(t, nil, nil, bridge.WithUIOrigins(bridge.ParseUIOrigins(" http://localhost:1500 , http://127.0.0.1:1500/ ")))
	for origin, allowed := range map[string]bool{
		"http://localhost:1500": true, "http://127.0.0.1:1500": true, "tauri://localhost": true, "http://localhost:1420": true,
		"http://localhost:1501": false,
	} {
		req, _ := http.NewRequest(http.MethodOptions, e.url+"/v1/projects", nil)
		req.Header.Set("Origin", origin)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if got := resp.Header.Get("Access-Control-Allow-Origin") == origin; got != allowed {
			t.Errorf("origin %s: allowed=%v", origin, got)
		}
	}
}
