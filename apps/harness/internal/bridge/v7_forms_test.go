package bridge_test

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/fakeacp"
	"github.com/ndolinschi/Octo/apps/harness/internal/inputs"
	"github.com/ndolinschi/Octo/apps/harness/internal/orchestrator"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

const testSecret = "sk-live-Zq81xT0pL9vB"

func (e *env) waitInputs(t *testing.T, pid string, n int) []inputs.Input {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for {
		var got struct{ Inputs []inputs.Input }
		e.into(t, "GET", "/v1/projects/"+pid+"/inputs", nil, http.StatusOK, &got)
		if len(got.Inputs) >= n {
			return got.Inputs
		}
		if time.Now().After(deadline) {
			t.Fatalf("only %d forms open, want %d", len(got.Inputs), n)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// assertNoLeak scans everything a client or the model could see for the secret.
func assertNoLeak(t *testing.T, e *env, pid string, evs []sseEvent, logs *syncBuf, secret string) {
	t.Helper()
	check := func(what string, data []byte) {
		t.Helper()
		if strings.Contains(string(data), secret) {
			t.Errorf("the secret value appears in %s", what)
		}
	}
	for _, ev := range evs {
		b, _ := json.Marshal(ev.Data)
		check("event "+ev.Type, b)
	}
	check("the log", []byte(logs.String()))
	for _, path := range []string{"", "/agents", "/secrets", "/inputs", "/approvals", "/changes", "/queue", "/context"} {
		_, raw := e.do(t, "GET", "/v1/projects/"+pid+path, nil)
		check("GET "+path, raw)
	}
	var agents struct{ Agents []projectstore.Agent }
	e.into(t, "GET", "/v1/projects/"+pid+"/agents", nil, http.StatusOK, &agents)
	for _, a := range agents.Agents {
		_, raw := e.do(t, "GET", "/v1/projects/"+pid+"/agents/"+a.ID+"/messages", nil)
		check("the transcript of "+a.Role, raw)
		_, raw = e.do(t, "GET", "/v1/projects/"+pid+"/context?agent="+a.ID, nil)
		check("the context of "+a.Role, raw)
	}
	for _, q := range []string{"agent_id", "model", "day"} {
		_, raw := e.do(t, "GET", "/v1/usage?group="+q, nil)
		check("usage by "+q, raw)
	}
}

func TestFormSecretNeverReachesTheModelOrAnythingElse(t *testing.T) {
	logs := captureLogs(t)
	e := newEnv(t, nil)
	pid, _ := e.v7Project(t, "full")
	stream := e.subscribe(t, pid)
	e.into(t, "POST", "/v1/projects/"+pid+"/messages", map[string]string{"text": "[form] set it up"}, http.StatusAccepted, nil)

	open := e.waitInputs(t, pid, 1)
	in := open[0]
	if in.Title != "Credentials" || len(in.Fields) != 2 || in.Fields[0].Kind != "secret" || in.AgentLabel != "orchestrator" || in.TurnID == 0 {
		t.Fatalf("input = %+v", in)
	}
	var proj struct {
		NeedsYou      bool `json:"needs_you"`
		PendingInputs int  `json:"pending_inputs"`
	}
	e.into(t, "GET", "/v1/projects/"+pid, nil, http.StatusOK, &proj)
	if !proj.NeedsYou || proj.PendingInputs != 1 {
		t.Fatalf("project = %+v", proj)
	}

	// Validation names fields, never values.
	for _, bad := range []map[string]any{
		{"values": map[string]any{"region": "eu"}},                      // secret required
		{"values": map[string]any{"api_key": "abc"}},                    // too short
		{"values": map[string]any{"api_key": testSecret, "bogus": "x"}}, // unknown field
		{"values": map[string]any{"api_key": 12345}},                    // not a string
	} {
		status, raw := e.do(t, "POST", "/v1/projects/"+pid+"/inputs/"+in.ID, bad)
		if status != http.StatusBadRequest || strings.Contains(string(raw), testSecret) {
			t.Fatalf("bad submission %v: %d %s", bad, status, raw)
		}
	}
	e.wantError(t, "POST", "/v1/projects/"+pid+"/inputs/inp_nope", map[string]any{"skip": true}, http.StatusNotFound, "not_found")

	e.into(t, "POST", "/v1/projects/"+pid+"/inputs/"+in.ID,
		map[string]any{"values": map[string]any{"api_key": testSecret, "region": "eu-west-1"}}, http.StatusNoContent, nil)
	evs := collectUntilTurnFinished(t, stream)

	// What the model got back, and said.
	var agents struct{ Agents []projectstore.Agent }
	e.into(t, "GET", "/v1/projects/"+pid+"/agents", nil, http.StatusOK, &agents)
	var msgs struct{ Messages []projectstore.Message }
	e.into(t, "GET", "/v1/projects/"+pid+"/agents/"+agents.Agents[0].ID+"/messages", nil, http.StatusOK, &msgs)
	var result string
	for _, m := range msgs.Messages {
		for _, b := range m.Content {
			if b.Type == "tool_result" && b.Content != nil {
				result = *b.Content
			}
		}
	}
	for _, want := range []string{`"status":"submitted"`, `"region":"eu-west-1"`, `"api_key":"provided"`, `"api_key":"secret:api_key"`} {
		if !strings.Contains(result, want) {
			t.Errorf("tool result %q lacks %s", result, want)
		}
	}
	// Events: opened and answered, with names only.
	var resolved map[string]any
	for _, ev := range evs {
		if ev.Type == "input.resolved" {
			resolved = ev.Data
		}
	}
	if count(evs, "input.requested") != 1 || resolved == nil || resolved["status"] != "submitted" ||
		len(resolved["provided"].([]any)) != 1 || resolved["provided"].([]any)[0] != "api_key" {
		t.Fatalf("input events: %+v", resolved)
	}
	assertNoLeak(t, e, pid, evs, logs, testSecret)

	// Stored by the harness, names only through the API, file mode 0600.
	var list struct{ Secrets []map[string]string }
	e.into(t, "GET", "/v1/projects/"+pid+"/secrets", nil, http.StatusOK, &list)
	if len(list.Secrets) != 1 || list.Secrets[0]["name"] != "api_key" {
		t.Fatalf("secrets = %+v", list)
	}
	if count(evs, "secrets.changed") != 1 {
		t.Fatalf("secrets.changed events = %d", count(evs, "secrets.changed"))
	}
	var done struct {
		NeedsYou bool `json:"needs_you"`
	}
	e.into(t, "GET", "/v1/projects/"+pid, nil, http.StatusOK, &done)
	if done.NeedsYou {
		t.Fatal("still needs you after the form was answered")
	}
}

func TestFormSkipAndCancel(t *testing.T) {
	e := newEnv(t, nil)
	pid, _ := e.v7Project(t, "full")
	stream := e.subscribe(t, pid)
	e.into(t, "POST", "/v1/projects/"+pid+"/messages", map[string]string{"text": "[form] one"}, http.StatusAccepted, nil)
	in := e.waitInputs(t, pid, 1)[0]
	e.into(t, "POST", "/v1/projects/"+pid+"/inputs/"+in.ID, map[string]any{"skip": true}, http.StatusNoContent, nil)
	evs := collectUntilTurnFinished(t, stream)
	found := false
	for _, ev := range evs {
		if ev.Type == "input.resolved" && ev.Data["status"] == "skipped" {
			found = true
		}
	}
	if !found {
		t.Fatal("no skipped event")
	}
	var list struct{ Secrets []map[string]string }
	e.into(t, "GET", "/v1/projects/"+pid+"/secrets", nil, http.StatusOK, &list)
	if len(list.Secrets) != 0 {
		t.Fatalf("a skipped form stored secrets: %+v", list)
	}

	stream = e.subscribe(t, pid)
	e.into(t, "POST", "/v1/projects/"+pid+"/messages", map[string]string{"text": "[form] two"}, http.StatusAccepted, nil)
	e.waitInputs(t, pid, 1)
	e.into(t, "POST", "/v1/projects/"+pid+"/cancel", nil, http.StatusAccepted, nil)
	evs = collectUntilTurnFinished(t, stream)
	cancelled := false
	for _, ev := range evs {
		if ev.Type == "input.resolved" && ev.Data["status"] == "cancelled" {
			cancelled = true
		}
	}
	if !cancelled || len(e.waitInputs(t, pid, 0)) != 0 {
		t.Fatal("cancel did not close the form")
	}
}

func TestSubAgentsUseSecretsThroughEnvWithoutSeeingThem(t *testing.T) {
	logs := captureLogs(t)
	e := newEnv(t, nil)
	pid, folder := e.v7Project(t, "full")
	stream := e.subscribe(t, pid)
	e.into(t, "POST", "/v1/projects/"+pid+"/messages", map[string]string{"text": "Go [ask] [usekey:api_key] [bash:echo ran > ran.txt]"}, http.StatusAccepted, nil)
	// Three sub-agents each open a form; answer them all.
	for _, in := range e.waitInputs(t, pid, 3) {
		e.into(t, "POST", "/v1/projects/"+pid+"/inputs/"+in.ID,
			map[string]any{"values": map[string]any{"api_key": testSecret}}, http.StatusNoContent, nil)
	}
	evs := collectUntilTurnFinished(t, stream)
	assertNoLeak(t, e, pid, evs, logs, testSecret)

	// The command ran with the value (it printed its length and the value, redacted).
	found := false
	var agents struct{ Agents []projectstore.Agent }
	e.into(t, "GET", "/v1/projects/"+pid+"/agents", nil, http.StatusOK, &agents)
	for _, a := range agents.Agents {
		var msgs struct{ Messages []projectstore.Message }
		e.into(t, "GET", "/v1/projects/"+pid+"/agents/"+a.ID+"/messages", nil, http.StatusOK, &msgs)
		for _, m := range msgs.Messages {
			for _, b := range m.Content {
				if b.Type == "tool_result" && b.Content != nil && strings.HasPrefix(*b.Content, "len=20\n[secret]") {
					found = true
				}
				if b.Type == "tool_use" && b.Name != nil && *b.Name == "bash" {
					found = found || false
				}
			}
		}
	}
	if !found {
		t.Fatal("no bash result showed the secret's length with its value redacted")
	}
	if _, err := os.Stat(filepath.Join(folder, "ran.txt")); err != nil {
		t.Fatal(err)
	}
	// An unknown secret is a tool error naming the variable, not a crash.
	e.runTurn(t, pid, "Again [usekey:nope]")
}

func TestSecretsAPI(t *testing.T) {
	e := newEnv(t, nil)
	pid, _ := e.v7Project(t, "full")
	e.into(t, "PUT", "/v1/projects/"+pid+"/secrets/token", map[string]string{"value": testSecret}, http.StatusNoContent, nil)
	e.into(t, "PUT", "/v1/projects/"+pid+"/secrets/token", map[string]string{"value": testSecret + "2"}, http.StatusNoContent, nil)
	for _, bad := range []struct{ name, value string }{{"1bad", testSecret}, {"ok", "abc"}} {
		status, raw := e.do(t, "PUT", "/v1/projects/"+pid+"/secrets/"+bad.name, map[string]string{"value": bad.value})
		if status != http.StatusBadRequest || strings.Contains(string(raw), testSecret) {
			t.Fatalf("%+v: %d %s", bad, status, raw)
		}
	}
	status, raw := e.do(t, "GET", "/v1/projects/"+pid+"/secrets", nil)
	if status != 200 || strings.Contains(string(raw), testSecret) || !strings.Contains(string(raw), `"token"`) {
		t.Fatalf("list: %d %s", status, raw)
	}
	e.into(t, "DELETE", "/v1/projects/"+pid+"/secrets/token", nil, http.StatusNoContent, nil)
	e.wantError(t, "DELETE", "/v1/projects/"+pid+"/secrets/token", nil, http.StatusNotFound, "not_found")
	e.wantError(t, "GET", "/v1/projects/prj_nope/secrets", nil, http.StatusNotFound, "not_found")
}

func TestACPOrchestratorOpensAFormThroughMCP(t *testing.T) {
	logs := captureLogs(t)
	e := newACPEnv(t, nil, nil)
	p := e.acpProject(t)
	ch := e.subscribe(t, p.ID)
	e.into(t, "POST", "/v1/projects/"+p.ID+"/messages", map[string]string{"text": fakeacp.MarkerAskForm + " go"}, http.StatusAccepted, nil)
	in := e.waitInputs(t, p.ID, 1)[0]
	if in.AgentID != p.OrchestratorAgentID || in.Fields[0].ID != "api_key" {
		t.Fatalf("input = %+v", in)
	}
	e.into(t, "POST", "/v1/projects/"+p.ID+"/inputs/"+in.ID,
		map[string]any{"values": map[string]any{"api_key": testSecret, "region": "us-east-2"}}, http.StatusNoContent, nil)
	tr := finishTurn(t, ch)
	if tr.status != "completed" {
		t.Fatalf("turn = %s %v", tr.status, tr.errMsg)
	}
	text := e.lastText(t, p)
	if !strings.Contains(text, `"api_key":"provided"`) || !strings.Contains(text, `"region":"us-east-2"`) {
		t.Fatalf("agent heard %q", text)
	}
	assertNoLeak(t, e.env, p.ID, tr.events, logs, testSecret)
}

var _ = orchestrator.ToolRequestInput
