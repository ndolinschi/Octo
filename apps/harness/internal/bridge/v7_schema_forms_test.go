package bridge_test

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

const schemaPassword = "Pw-e2e-Zq81xT0pL9vB"

// Criteria 1, 4, 5: the [schemaform] sign-in form carries the normalised
// schema; a bad answer is 400 invalid_request with error.fields and no value;
// the password is stored as a secret and appears nowhere else.
func TestSchemaFormRefusesByFieldAndKeepsThePasswordSecret(t *testing.T) {
	logs := captureLogs(t)
	e := newEnv(t, nil)
	pid, _ := e.v7Project(t, "full")
	stream := e.subscribe(t, pid)
	e.into(t, "POST", "/v1/projects/"+pid+"/messages", map[string]string{"text": "[schemaform] sign in"}, http.StatusAccepted, nil)
	in := e.waitInputs(t, pid, 1)[0]
	if in.Title != "Sign in to staging" || len(in.Fields) != 0 || in.Source == nil || in.Source.Kind != "tool" {
		t.Fatalf("input = %+v", in)
	}
	if got := in.Schema.Octo.Order; strings.Join(got, ",") != "email,password,remember" {
		t.Fatalf("order = %v", got)
	}
	_, raw := e.do(t, "GET", "/v1/projects/"+pid+"/inputs", nil)
	if !strings.Contains(string(raw), `"fields":[]`) || !strings.Contains(string(raw), `"x-octo":{"order":["email","password","remember"]}`) {
		t.Fatalf("GET inputs = %s", raw)
	}

	status, raw := e.do(t, "POST", "/v1/projects/"+pid+"/inputs/"+in.ID, map[string]any{"values": map[string]any{"email": "not-an-email"}})
	var refused struct {
		Error struct {
			Code, Message, Details string
			Fields                 map[string]string
		}
	}
	if err := json.Unmarshal(raw, &refused); err != nil || status != http.StatusBadRequest || refused.Error.Code != "invalid_request" {
		t.Fatalf("refusal: %d %s", status, raw)
	}
	if refused.Error.Fields["email"] != "Enter an email address like name@example.com" || refused.Error.Fields["password"] != "Required" ||
		len(refused.Error.Fields) != 2 || strings.Contains(string(raw), "not-an-email") {
		t.Fatalf("refusal = %s", raw)
	}
	status, raw = e.do(t, "POST", "/v1/projects/"+pid+"/inputs/"+in.ID, map[string]any{"values": map[string]any{"email": "a@b.co", "password": "short"}})
	if status != http.StatusBadRequest || strings.Contains(string(raw), "short\"") || !strings.Contains(string(raw), "Use 8 characters or more") {
		t.Fatalf("short password: %d %s", status, raw)
	}

	e.into(t, "POST", "/v1/projects/"+pid+"/inputs/"+in.ID,
		map[string]any{"values": map[string]any{"email": "qa@example.com", "password": schemaPassword, "remember": true}}, http.StatusNoContent, nil)
	evs := collectUntilTurnFinished(t, stream)
	assertNoLeak(t, e, pid, evs, logs, schemaPassword)
	if strings.Contains(logs.String(), "not-an-email") {
		t.Error("a refused value is in the log")
	}

	var agents struct{ Agents []projectstore.Agent }
	e.into(t, "GET", "/v1/projects/"+pid+"/agents", nil, http.StatusOK, &agents)
	var msgs struct{ Messages []projectstore.Message }
	e.into(t, "GET", "/v1/projects/"+pid+"/agents/"+agents.Agents[0].ID+"/messages", nil, http.StatusOK, &msgs)
	var result, call string
	for _, m := range msgs.Messages {
		for _, b := range m.Content {
			if b.Type == "tool_result" && b.Content != nil {
				result = *b.Content
			}
			if b.Type == "tool_use" {
				c, _ := json.Marshal(b.Input)
				call = string(c)
			}
		}
	}
	for _, want := range []string{`"status":"submitted"`, `"email":"qa@example.com"`, `"remember":true`, `"password":"provided"`, `"password":"secret:password"`} {
		if !strings.Contains(result, want) {
			t.Errorf("tool result %q lacks %s", result, want)
		}
	}
	if !strings.Contains(call, `"schema"`) {
		t.Errorf("the stored tool call lacks the schema: %s", call)
	}
	var list struct{ Secrets []map[string]string }
	e.into(t, "GET", "/v1/projects/"+pid+"/secrets", nil, http.StatusOK, &list)
	if len(list.Secrets) != 1 || list.Secrets[0]["name"] != "password" {
		t.Fatalf("secrets = %+v", list)
	}
	var resolved map[string]any
	for _, ev := range evs {
		if ev.Type == "input.resolved" {
			resolved = ev.Data
		}
	}
	vals, _ := resolved["values"].(map[string]any)
	if resolved == nil || vals["remember"] != true || vals["password"] != nil {
		t.Fatalf("input.resolved = %+v", resolved)
	}
}

// Criterion 2: a legacy form also carries the converted schema, and old answers work.
func TestLegacyFormCarriesTheConvertedSchema(t *testing.T) {
	e := newEnv(t, nil)
	pid, _ := e.v7Project(t, "full")
	stream := e.subscribe(t, pid)
	e.into(t, "POST", "/v1/projects/"+pid+"/messages", map[string]string{"text": "[form] set it up"}, http.StatusAccepted, nil)
	in := e.waitInputs(t, pid, 1)[0]
	p, ok := in.Schema.Properties.Get("api_key")
	if len(in.Fields) != 2 || !ok || !p.IsPassword() || strings.Join(in.Schema.Octo.Order, ",") != "api_key,region" ||
		strings.Join(in.Schema.Required, ",") != "api_key" {
		t.Fatalf("input = %+v", in)
	}
	status, raw := e.do(t, "POST", "/v1/projects/"+pid+"/inputs/"+in.ID, map[string]any{"values": map[string]any{"region": "eu"}})
	if status != http.StatusBadRequest || !strings.Contains(string(raw), `"fields":{"api_key":"Required"}`) || !strings.Contains(string(raw), "api_key") {
		t.Fatalf("refusal: %d %s", status, raw)
	}
	e.into(t, "POST", "/v1/projects/"+pid+"/inputs/"+in.ID,
		map[string]any{"values": map[string]any{"api_key": testSecret, "region": "eu-west-1"}}, http.StatusNoContent, nil)
	collectUntilTurnFinished(t, stream)
}
