package inputs

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

const deploy = `{"type":"object","required":["replicas","region"],"properties":{
  "replicas":{"type":"integer","minimum":1,"maximum":10},
  "ratio":{"type":"number","minimum":0.5},
  "region":{"type":"string","oneOf":[{"const":"eu","title":"Europe"},{"const":"us","title":"US"}]},
  "checks":{"type":"array","items":{"type":"string","enum":["unit","lint","e2e"]},"minItems":1,"maxItems":2},
  "canary":{"type":"boolean"},
  "percent":{"type":"number","minimum":1,"maximum":50,"x-octo":{"visible_when":{"field":"canary","equals":true}}},
  "site":{"type":"string","format":"uri"},
  "day":{"type":"string","format":"date"},
  "at":{"type":"string","format":"date-time"},
  "code":{"type":"string","pattern":"^[A-Z]{3}$","maxLength":3},
  "terms":{"type":"boolean","x-octo":{"accept":true}}}}`

// Criteria 4, 6, 7: typed values reach the result; each refusal is under its
// field, in the card's words, and never holds the submitted value.
func TestCheckAnswer(t *testing.T) {
	sd := mustParse(t, deploy)
	ss := mustParse(t, signIn)
	ok := map[string]any{"replicas": 3.0, "region": "eu", "terms": true}
	with := func(kv ...any) map[string]any {
		m := map[string]any{}
		for k, v := range ok {
			m[k] = v
		}
		for i := 0; i < len(kv); i += 2 {
			if kv[i+1] == nil {
				delete(m, kv[i].(string))
			} else {
				m[kv[i].(string)] = kv[i+1]
			}
		}
		return m
	}
	for _, tc := range []struct {
		name   string
		s      Schema
		values map[string]any
		errs   map[string]string
		vals   map[string]any
	}{
		{"minimal", sd, ok, nil, map[string]any{"replicas": int64(3), "region": "eu", "terms": true}},
		{"typed values", sd, with("ratio", 0.75, "checks", []any{"unit", "lint"}, "canary", true, "percent", 10.0,
			"site", "https://example.com/x", "day", "2026-12-31", "at", "2026-12-31T10:00:00+02:00", "code", "ABC"), nil,
			map[string]any{"replicas": int64(3), "region": "eu", "terms": true, "ratio": 0.75, "checks": []string{"unit", "lint"},
				"canary": true, "percent": 10.0, "site": "https://example.com/x", "day": "2026-12-31", "at": "2026-12-31T10:00:00+02:00", "code": "ABC"}},
		{"above maximum", sd, with("replicas", 11.0), map[string]string{"replicas": "Enter a number from 1 to 10"}, nil},
		{"below minimum", sd, with("ratio", 0.1), map[string]string{"ratio": "Enter a number of at least 0.5"}, nil},
		{"not whole", sd, with("replicas", 2.5), map[string]string{"replicas": msgWhole}, nil},
		{"number as string", sd, with("replicas", "3"), map[string]string{"replicas": msgNumber}, nil},
		{"too few items", sd, with("checks", []any{}), nil, map[string]any{"replicas": int64(3), "region": "eu", "terms": true}},
		{"too many items", sd, with("checks", []any{"unit", "lint", "e2e"}), map[string]string{"checks": "Choose at most 2"}, nil},
		{"item outside choices", sd, with("checks", []any{"fuzz"}), map[string]string{"checks": msgList}, nil},
		{"item twice", sd, with("checks", []any{"unit", "unit"}), map[string]string{"checks": msgTwice}, nil},
		{"not a choice", sd, with("region", "asia"), map[string]string{"region": msgOption}, nil},
		{"required missing", sd, with("replicas", nil, "region", " "), map[string]string{"replicas": msgRequired, "region": msgChoose}, nil},
		{"accept unticked", sd, with("terms", false), map[string]string{"terms": msgConfirm}, nil},
		{"accept missing", sd, with("terms", nil), map[string]string{"terms": msgConfirm}, nil},
		{"hidden field sent", sd, with("canary", false, "percent", 10.0), map[string]string{"percent": answerHiddenField}, nil},
		{"hidden field omitted", sd, with("canary", false), nil, map[string]any{"replicas": int64(3), "region": "eu", "terms": true, "canary": false}},
		{"visible field checked", sd, with("canary", true, "percent", 99.0), map[string]string{"percent": "Enter a number from 1 to 50"}, nil},
		{"bad uri", sd, with("site", "example.com"), map[string]string{"site": msgURI}, nil},
		{"bad date", sd, with("day", "31/12/2026"), map[string]string{"day": msgDate}, nil},
		{"date-time without offset", sd, with("at", "2026-12-31T10:00"), map[string]string{"at": msgDateTime}, nil},
		{"pattern", sd, with("code", "abc"), map[string]string{"code": msgPattern}, nil},
		{"maxLength", sd, with("code", "ABCD"), map[string]string{"code": "Use 3 characters or fewer"}, nil},
		{"unknown id", sd, with("bogus", "x"), map[string]string{"bogus": msgUnknown}, nil},
		{"malformed unknown key", sd, with("sk live secret!", "x"), map[string]string{"(unknown)": msgUnknown}, nil},
		{"bad email and missing password", ss, map[string]any{"email": "not-an-email"},
			map[string]string{"email": msgEmail, "password": msgRequired}, nil},
		{"short password", ss, map[string]any{"email": "a@b.co", "password": "short12"}, map[string]string{"password": "Use 8 characters or more"}, nil},
		{"sign in", ss, map[string]any{"email": "a@b.co", "password": "longenough", "remember": true}, nil, map[string]any{"email": "a@b.co", "remember": true}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			res, errs := CheckAnswer(tc.s, Answer{Values: tc.values})
			if !reflect.DeepEqual(errs, tc.errs) {
				t.Fatalf("errs = %v, want %v", errs, tc.errs)
			}
			if tc.errs != nil {
				for _, msg := range errs {
					for _, v := range tc.values {
						if s, isStr := v.(string); isStr && len(s) > 2 && strings.Contains(msg, s) {
							t.Errorf("message %q holds the value %q", msg, s)
						}
					}
				}
				return
			}
			if res.Status != StatusSubmitted || !reflect.DeepEqual(res.Values, tc.vals) {
				t.Fatalf("values = %#v, want %#v", res.Values, tc.vals)
			}
		})
	}
	res, _ := CheckAnswer(ss, Answer{Values: map[string]any{"email": "a@b.co", "password": "longenough"}})
	if res.Secrets["password"] != "longenough" || res.Values["password"] != nil {
		t.Fatalf("password went to %+v", res)
	}
	if res, errs := CheckAnswer(ss, Answer{Skip: true}); errs != nil || res.Status != StatusSkipped {
		t.Fatalf("skip = %+v %v", res, errs)
	}
}

func TestFormatChecks(t *testing.T) {
	for s, want := range map[string]bool{"a@b.co": true, "a.b+c@x.example.org": true, "a@b": false, "@b.co": false, "a b@c.de": false,
		"a@@b.co": false, "a@.b.co": false, "a@b.co.": false, "a@b..co": false} {
		if IsEmail(s) != want {
			t.Errorf("IsEmail(%q) = %v", s, !want)
		}
	}
	for s, want := range map[string]bool{"https://x.dev": true, "mailto:a@b.co": true, "ftp://h/p": true, "https://": false,
		"example.com": false, "https://a b": false, "1http://x": false, "x:": false} {
		if IsURI(s) != want {
			t.Errorf("IsURI(%q) = %v", s, !want)
		}
	}
}

// Criterion 2: a legacy form is converted, and answers are judged as before.
func TestFromFieldsKeepsLegacyAnswers(t *testing.T) {
	fields := []Field{
		{ID: "api_key", Label: "API key", Kind: KindSecret, Required: true, Help: "From the dashboard"},
		{ID: "region", Label: "Region", Kind: KindText},
		{ID: "env", Label: "Environment", Kind: KindSelect, Options: []string{"dev", "prod"}},
		{ID: "ok", Label: "Proceed", Kind: KindConfirm},
		{ID: "dir", Label: "Folder", Kind: KindPath},
	}
	if err := Validate("T", fields); err != nil {
		t.Fatal(err)
	}
	s := FromFields(fields)
	b, _ := json.Marshal(s)
	want := `{"type":"object","properties":{"api_key":{"type":"string","title":"API key","description":"From the dashboard","format":"password"},` +
		`"region":{"type":"string","title":"Region"},"env":{"type":"string","title":"Environment","enum":["dev","prod"]},` +
		`"ok":{"type":"boolean","title":"Proceed"},"dir":{"type":"string","title":"Folder","x-octo":{"widget":"path"}}},` +
		`"required":["api_key"],"x-octo":{"order":["api_key","region","env","ok","dir"]}}`
	if string(b) != want {
		t.Fatalf("FromFields =\n%s\nwant\n%s", b, want)
	}
	if _, err := ParseSchema(b, OriginTool); err != nil {
		t.Fatalf("the converted schema does not parse: %v", err)
	}
	for _, tc := range []struct {
		values map[string]any
		ok     bool
	}{
		{map[string]any{"api_key": "sk-1234", "region": "eu-west-1"}, true},
		{map[string]any{"api_key": "sk-1234", "region": "  ", "env": "prod", "ok": false, "dir": "/x"}, true},
		{map[string]any{"region": "eu"}, false},
		{map[string]any{"api_key": "abc"}, false},
		{map[string]any{"api_key": "sk-1234", "bogus": "x"}, false},
		{map[string]any{"api_key": 12345}, false},
		{map[string]any{"api_key": "sk-1234", "env": "staging"}, false},
		{map[string]any{"api_key": "sk-1234", "ok": "yes"}, false},
	} {
		res, errs := CheckAnswer(s, Answer{Values: tc.values})
		if (errs == nil) != tc.ok {
			t.Errorf("%v: errs = %v, want ok=%v", tc.values, errs, tc.ok)
		}
		if tc.ok && (res.Secrets["api_key"] != "sk-1234" || res.Values["api_key"] != nil) {
			t.Errorf("%v: result %+v", tc.values, res)
		}
		if tc.ok && tc.values["region"] == "  " && res.Values["region"] != nil {
			t.Errorf("a blank text field was kept: %+v", res.Values)
		}
	}
	// A required confirm must be ticked (the old UI's rule, now the service's too).
	req := FromFields([]Field{{ID: "ok", Label: "Proceed", Kind: KindConfirm, Required: true}})
	if _, errs := CheckAnswer(req, Answer{Values: map[string]any{"ok": false}}); errs["ok"] != msgConfirm {
		t.Fatalf("errs = %v", errs)
	}
}
