package inputs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

const signIn = `{"type": "object", "required": ["email", "password"],
  "properties": {
   "email": {"type": "string", "format": "email", "title": "Email", "x-octo": {"placeholder": "you@example.com"}},
   "password": {"type": "string", "format": "password", "title": "Password", "minLength": 8},
   "remember": {"type": "boolean", "title": "Keep me signed in for this project", "default": true}}}`

func mustParse(t *testing.T, raw string) Schema {
	t.Helper()
	s, err := ParseSchema(json.RawMessage(raw), OriginTool)
	if err != nil {
		t.Fatalf("ParseSchema: %v", err)
	}
	return s
}

// Criterion 1: request_input with the sign-in schema opens a form whose
// input.requested carries the normalised schema with x-octo.order.
func TestSignInSchemaOpensANormalisedForm(t *testing.T) {
	s := mustParse(t, signIn)
	if got := s.Octo.Order; !reflect.DeepEqual(got, []string{"email", "password", "remember"}) {
		t.Fatalf("order = %v", got)
	}
	var mu sync.Mutex
	var published []byte
	m := New(func(pid, typ string, f map[string]any) {
		if typ == "input.requested" {
			b, _ := json.Marshal(f)
			mu.Lock()
			published = b
			mu.Unlock()
		}
	}, nil)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _ = m.Request(ctx, "p", Input{Title: "Sign in to staging", Schema: s, Source: &Source{Kind: sourceKindTool}})
	}()
	for deadline := time.Now().Add(5 * time.Second); m.Count("p") == 0; {
		if time.Now().After(deadline) {
			t.Fatal("no form opened")
		}
		time.Sleep(time.Millisecond)
	}
	cancel()
	<-done
	mu.Lock()
	defer mu.Unlock()
	var ev struct {
		Input struct {
			Fields []Field         `json:"fields"`
			Source Source          `json:"source"`
			Schema json.RawMessage `json:"schema"`
		} `json:"input"`
	}
	if err := json.Unmarshal(published, &ev); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"x-octo":{"order":["email","password","remember"]}`, `"required":["email","password"]`,
		`"properties":{"email":`, `"format":"password"`, `"default":true`} {
		if !strings.Contains(string(ev.Input.Schema), want) {
			t.Errorf("schema %s lacks %s", ev.Input.Schema, want)
		}
	}
	if ev.Input.Fields == nil || len(ev.Input.Fields) != 0 || ev.Input.Source.Kind != "tool" {
		t.Errorf("fields = %v, source = %+v (want [] and tool)", ev.Input.Fields, ev.Input.Source)
	}
	// The normalised schema parses again to the same thing.
	again := mustParse(t, string(ev.Input.Schema))
	if !reflect.DeepEqual(again, s) {
		t.Errorf("round trip changed the schema:\n%+v\n%+v", again, s)
	}
}

func props(n int) string {
	var b strings.Builder
	for i := range n {
		if i > 0 {
			b.WriteByte(',')
		}
		fmt.Fprintf(&b, `"f%d":{"type":"string"}`, i)
	}
	return `{"type":"object","properties":{` + b.String() + `}}`
}

func one(prop string) string {
	return `{"type":"object","properties":{"a":{"type":"string"},"x":` + prop + `}}`
}

// Criterion 3 and the hostile-schema limits: each refused, naming the cause.
func TestParseSchemaRefuses(t *testing.T) {
	big := `{"type":"object","properties":{"a":{"type":"string","description":"` + strings.Repeat("x", 33<<10) + `"}}}`
	many := `[` + strings.TrimSuffix(strings.Repeat(`"c",`, 51), ",") + `]`
	var choices51 []string
	for i := range 51 {
		choices51 = append(choices51, fmt.Sprintf(`"c%d"`, i))
	}
	groups9 := `{"type":"object","properties":{"a":{"type":"string"}},"x-octo":{"groups":[` +
		strings.TrimSuffix(strings.Repeat(`{"title":"g","fields":["a"]},`, 9), ",") + `]}}`
	for _, tc := range []struct{ name, raw, want string }{
		{"nested object", one(`{"type":"object","properties":{"b":{"type":"string"}}}`), "nested objects are not supported"},
		{"$ref", one(`{"$ref":"#/$defs/x"}`), `keyword "$ref" is not supported`},
		{"$defs at the top", `{"type":"object","$defs":{},"properties":{"a":{"type":"string"}}}`, `keyword "$defs"`},
		{"allOf", one(`{"type":"string","allOf":[]}`), `keyword "allOf"`},
		{"if", one(`{"type":"string","if":{}}`), `keyword "if"`},
		{"21 properties", props(21), "1 to 20 properties"},
		{"no properties", `{"type":"object","properties":{}}`, "1 to 20 properties"},
		{"33 KiB", big, "at most 32768 (32 KiB)"},
		{"pattern Go cannot compile", one(`{"type":"string","pattern":"(?<=a)b"}`), "does not compile as an RE2"},
		{"backreference", one(`{"type":"string","pattern":"(a)\\1"}`), "does not compile as an RE2"},
		{"long pattern", one(`{"type":"string","pattern":"` + strings.Repeat("a", 257) + `"}`), "pattern is at most 256 bytes"},
		{"not an object", `[1]`, "must be a JSON object"},
		{"not JSON", `{"type":`, "not valid JSON"},
		{"type not object", `{"type":"string","properties":{"a":{"type":"string"}}}`, `type must be "object"`},
		{"deep nesting", `{"type":"object","properties":{"a":{"type":"string","x-octo":{"visible_when":{"field":"b","equals":[[["x"]]]}}}}}`, "nested more than 6 levels"},
		{"duplicate id", `{"type":"object","properties":{"a":{"type":"string"},"a":{"type":"number"}}}`, `duplicate property id "a"`},
		{"bad id", `{"type":"object","properties":{"1a":{"type":"string"}}}`, `property id "1a" must start with a letter`},
		{"no type", one(`{"title":"X"}`), "needs a type"},
		{"type list", one(`{"type":["string","null"]}`), `"type" has the wrong type`},
		{"unknown type", one(`{"type":"null"}`), `type "null" is not supported`},
		{"unknown keyword", one(`{"type":"string","exclusiveMinimum":3}`), `keyword "exclusiveMinimum"`},
		{"unknown x-octo key", one(`{"type":"string","x-octo":{"color":"red"}}`), `keyword "color"`},
		{"unknown format", one(`{"type":"string","format":"hostname"}`), `format "hostname" is not supported`},
		{"enum and oneOf", one(`{"type":"string","enum":["a"],"oneOf":[{"const":"a","title":"A"}]}`), "enum or oneOf, not both"},
		{"enum with format", one(`{"type":"string","enum":["a"],"format":"email"}`), `"format" does not apply`},
		{"minimum on a string", one(`{"type":"string","minimum":1}`), `"minimum" does not apply`},
		{"enumNames length", one(`{"type":"string","enum":["a","b"],"enumNames":["A"]}`), "one name per enum value"},
		{"51 choices", one(`{"type":"string","enum":[` + strings.Join(choices51, ",") + `]}`), "1 to 50 choices"},
		{"duplicate choice", one(`{"type":"string","enum":["a","a"]}`), `choice "a" is listed twice`},
		{"51 anyOf", one(`{"type":"array","items":{"anyOf":` + many + `}}`), "1 to 50 choices"},
		{"choice without title", one(`{"type":"string","oneOf":[{"const":"a"}]}`), "title is required"},
		{"choice extra key", one(`{"type":"string","oneOf":[{"const":"a","title":"A","x":1}]}`), `keyword "x"`},
		{"9 groups", groups9, "at most 8 groups"},
		{"group of unknown field", `{"type":"object","properties":{"a":{"type":"string"}},"x-octo":{"groups":[{"title":"G","fields":["b"]}]}}`, `names "b", which is not a property`},
		{"field in two groups", `{"type":"object","properties":{"a":{"type":"string"}},"x-octo":{"groups":[{"title":"G","fields":["a"]},{"title":"H","fields":["a"]}]}}`, "in two groups"},
		{"long property title", one(`{"type":"string","title":"` + strings.Repeat("t", 121) + `"}`), "title is at most 120"},
		{"long description", one(`{"type":"string","description":"` + strings.Repeat("d", 501) + `"}`), "description is at most 500"},
		{"long placeholder", one(`{"type":"string","x-octo":{"placeholder":"` + strings.Repeat("p", 121) + `"}}`), "placeholder is at most 120"},
		{"long submit label", `{"type":"object","properties":{"a":{"type":"string"}},"x-octo":{"submit_label":"` + strings.Repeat("s", 41) + `"}}`, "submit_label is at most 40"},
		{"order names unknown", `{"type":"object","properties":{"a":{"type":"string"}},"x-octo":{"order":["b"]}}`, "x-octo.order names \"b\""},
		{"required names unknown", `{"type":"object","properties":{"a":{"type":"string"}},"required":["b"]}`, "required names \"b\""},
		{"required twice", `{"type":"object","properties":{"a":{"type":"string"}},"required":["a","a"]}`, `names "a" twice`},
		{"password default", one(`{"type":"string","format":"password","default":"hunter22"}`), "a password cannot have a default"},
		{"min above max", one(`{"type":"number","minimum":5,"maximum":1}`), "minimum is above maximum"},
		{"minLength above maxLength", one(`{"type":"string","minLength":5,"maxLength":1}`), "minLength is above maxLength"},
		{"negative length", one(`{"type":"string","minLength":-1}`), "cannot be negative"},
		{"minItems above choices", one(`{"type":"array","items":{"type":"string","enum":["a"]},"minItems":2}`), "above the number of choices"},
		{"array of objects", one(`{"type":"array","items":{"type":"object"}}`), "arrays of objects are not supported"},
		{"array without items", one(`{"type":"array"}`), "needs items"},
		{"items enum without type", one(`{"type":"array","items":{"enum":["a"]}}`), `need "type": "string"`},
		{"default outside the range", one(`{"type":"integer","minimum":1,"maximum":10,"default":11}`), "default does not fit"},
		{"default not a choice", one(`{"type":"string","enum":["a"],"default":"b"}`), "default does not fit"},
		{"visible_when on a later field", `{"type":"object","properties":{"a":{"type":"string","x-octo":{"visible_when":{"field":"b","equals":"x"}}},"b":{"type":"string"}}}`, "must be an earlier property"},
		{"visible_when on itself", `{"type":"object","properties":{"a":{"type":"string","x-octo":{"visible_when":{"field":"a","equals":"x"}}}}}`, "must be an earlier property"},
		{"visible_when on a password", `{"type":"object","properties":{"p":{"type":"string","format":"password"},"a":{"type":"string","x-octo":{"visible_when":{"field":"p","equals":"x"}}}}}`, "cannot depend on a password"},
		{"visible_when wrong type", `{"type":"object","properties":{"c":{"type":"boolean"},"a":{"type":"string","x-octo":{"visible_when":{"field":"c","equals":"yes"}}}}}`, "can never have"},
		{"visible_when not a choice", `{"type":"object","properties":{"c":{"type":"string","enum":["x"]},"a":{"type":"string","x-octo":{"visible_when":{"field":"c","equals":"y"}}}}}`, "can never have"},
		{"visible_when object", `{"type":"object","properties":{"c":{"type":"string"},"a":{"type":"string","x-octo":{"visible_when":{"field":"c","equals":{}}}}}}`, "equals must be"},
		{"visible_when many-of", `{"type":"object","properties":{"c":{"type":"array","items":{"type":"string","enum":["x"]}},"a":{"type":"string","x-octo":{"visible_when":{"field":"c","equals":"x"}}}}}`, "many-of"},
		{"multiline on a number", one(`{"type":"number","x-octo":{"multiline":true}}`), "multiline applies"},
		{"step on a string", one(`{"type":"string","x-octo":{"step":1}}`), "step applies"},
		{"step zero", one(`{"type":"number","x-octo":{"step":0}}`), "step must be above zero"},
		{"accept on a string", one(`{"type":"string","x-octo":{"accept":true}}`), "accept applies"},
		{"bad widget", one(`{"type":"string","x-octo":{"widget":"color"}}`), `widget must be "path"`},
		{"path_kind without widget", one(`{"type":"string","x-octo":{"path_kind":"file"}}`), "needs the path widget"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := ParseSchema(json.RawMessage(tc.raw), OriginTool)
			var ve *ValidationError
			if !errors.As(err, &ve) {
				t.Fatalf("err = %v, want a ValidationError", err)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %q, want it to name %q", err, tc.want)
			}
			if len(err.Error()) > 400 {
				t.Errorf("error is %d bytes long", len(err.Error()))
			}
		})
	}
}

func TestPasswordOnlyFromATool(t *testing.T) {
	for _, o := range []Origin{OriginReply, OriginToolServer} {
		if _, err := ParseSchema(json.RawMessage(signIn), o); err == nil || !strings.Contains(err.Error(), "only request_input may ask for a password") {
			t.Errorf("%s: err = %v", o, err)
		}
	}
	if _, err := ParseSchema(json.RawMessage(`{"type":"object","properties":{"bad id!":{"type":"string","format":"password"}}}`), OriginTool); err == nil {
		t.Error("a password with an invalid id was accepted")
	}
}

func TestParseSchemaAccepts(t *testing.T) {
	for _, tc := range []struct {
		name, raw string
		order     []string
	}{
		{"annotations dropped", `{"$schema":"https://json-schema.org/draft/2020-12/schema","title":"T","description":"D","additionalProperties":false,
		  "type":"object","properties":{"a":{"type":"string","$comment":"c","examples":["x"]}}}`, []string{"a"}},
		{"partial order first", `{"type":"object","properties":{"a":{"type":"string"},"b":{"type":"number"},"c":{"type":"boolean"}},"x-octo":{"order":["c"]}}`, []string{"c", "a", "b"}},
		{"MCP enum forms", `{"type":"object","properties":{
		   "u":{"type":"string","enum":["a","b"]},
		   "t":{"type":"string","oneOf":[{"const":"a","title":"A"},{"const":"b","title":"B"}]},
		   "l":{"type":"string","enum":["a","b"],"enumNames":["A","B"]},
		   "m":{"type":"array","items":{"type":"string","enum":["a","b"]},"minItems":1,"maxItems":2,"uniqueItems":true},
		   "n":{"type":"array","items":{"anyOf":[{"const":"a","title":"A"}]},"default":["a"]}}}`, []string{"u", "t", "l", "m", "n"}},
		{"deploy settings", `{"type":"object","properties":{
		   "replicas":{"type":"integer","minimum":1,"maximum":10,"default":3,"x-octo":{"step":1}},
		   "window":{"type":"string","format":"date-time"},
		   "canary":{"type":"boolean","default":false},
		   "percent":{"type":"number","minimum":1,"maximum":50,"x-octo":{"visible_when":{"field":"canary","equals":true}}},
		   "where":{"type":"string","x-octo":{"widget":"path","path_kind":"folder","multiline":false}},
		   "notes":{"type":"string","x-octo":{"multiline":true,"placeholder":"Anything else"}}},
		  "x-octo":{"groups":[{"title":"Rollout","fields":["replicas","canary","percent"]}],"submit_label":"Deploy"}}`,
			[]string{"replicas", "window", "canary", "percent", "where", "notes"}},
		{"20 properties", props(20), nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := mustParse(t, tc.raw)
			if tc.order != nil && !reflect.DeepEqual(s.Octo.Order, tc.order) {
				t.Fatalf("order = %v, want %v", s.Octo.Order, tc.order)
			}
			b, err := json.Marshal(s)
			if err != nil {
				t.Fatal(err)
			}
			for _, gone := range []string{"$schema", "additionalProperties", "$comment", "examples", "uniqueItems"} {
				if strings.Contains(string(b), gone) {
					t.Errorf("%s survived normalisation: %s", gone, b)
				}
			}
		})
	}
}
