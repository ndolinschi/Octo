package orchestrator

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/inputs"
)

// Criterion 3 (tool side): request_input refuses a bad call with a tool error naming the cause.
func TestRequestInputFormOf(t *testing.T) {
	fields := []inputs.Field{{ID: "a", Label: "A", Kind: inputs.KindText}}
	okSchema := json.RawMessage(`{"type":"object","properties":{"a":{"type":"string"}}}`)
	for _, tc := range []struct {
		name string
		in   requestInputArgs
		want string
	}{
		{"both", requestInputArgs{Title: "T", Fields: fields, Schema: okSchema}, "Pass fields or schema, not both"},
		{"neither", requestInputArgs{Title: "T"}, "Pass fields or schema, not both"},
		{"null schema and no fields", requestInputArgs{Title: "T", Schema: json.RawMessage("null")}, "Pass fields or schema, not both"},
		{"no title", requestInputArgs{Schema: okSchema}, "title is required"},
		{"nested", requestInputArgs{Title: "T", Schema: json.RawMessage(`{"type":"object","properties":{"o":{"type":"object"}}}`)}, "nested objects"},
		{"$ref", requestInputArgs{Title: "T", Schema: json.RawMessage(`{"type":"object","properties":{"o":{"$ref":"#/x"}}}`)}, `"$ref"`},
		{"legacy still checked", requestInputArgs{Title: "T", Fields: []inputs.Field{{ID: "a", Label: "A", Kind: "bogus"}}}, "kind must be"},
		{"schema ok", requestInputArgs{Title: "T", Schema: okSchema}, ""},
		{"schema as a string", requestInputArgs{Title: "T", Schema: json.RawMessage(`"{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}"`)}, ""},
		{"fields ok", requestInputArgs{Title: "T", Fields: fields}, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, err := formOf(tc.in)
			if tc.want == "" {
				if err != nil || len(s.Properties) != 1 || s.Octo == nil || s.Octo.Order[0] != "a" {
					t.Fatalf("schema = %+v, err = %v", s, err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want %q", err, tc.want)
			}
		})
	}
}

func TestInputResultNamesSecretsOnly(t *testing.T) {
	s, err := inputs.ParseSchema(json.RawMessage(`{"type":"object","properties":{"email":{"type":"string"},"password":{"type":"string","format":"password"},"n":{"type":"integer"}}}`), inputs.OriginTool)
	if err != nil {
		t.Fatal(err)
	}
	got := inputResult(inputs.Result{Status: inputs.StatusSubmitted, Values: map[string]any{"email": "a@b.co", "n": int64(3)},
		Secrets: map[string]string{"password": "hunter2222"}}, s)
	want := `{"secrets":{"password":"provided"},"status":"submitted","use_as":{"password":"secret:password"},"values":{"email":"a@b.co","n":3}}`
	if got != want {
		t.Fatalf("result = %s", got)
	}
}
