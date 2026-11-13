package acp

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestParseCommandsEveryShape(t *testing.T) {
	cases := map[string]struct {
		in   string
		want []Command
	}{
		"schema object input": {
			`[{"name":"web","description":"Search","input":{"hint":"query to search for"}}]`,
			[]Command{{Name: "web", Description: "Search", InputHint: "query to search for"}},
		},
		"no input":        {`[{"name":"init","description":"Set up"}]`, []Command{{Name: "init", Description: "Set up"}}},
		"null input":      {`[{"name":"init","description":"x","input":null}]`, []Command{{Name: "init", Description: "x"}}},
		"input as string": {`[{"name":"a","description":"d","input":"file"}]`, []Command{{Name: "a", Description: "d", InputHint: "file"}}},
		"hint beside name": {
			`[{"name":"a","description":"d","hint":"h1"},{"name":"b","description":"d","inputHint":"h2"},{"name":"c","description":"d","input_hint":"h3"}]`,
			[]Command{{Name: "a", Description: "d", InputHint: "h1"}, {Name: "b", Description: "d", InputHint: "h2"}, {Name: "c", Description: "d", InputHint: "h3"}},
		},
		"leading slash and meta": {`[{"name":"/review","description":"r","_meta":{"x":1}}]`, []Command{{Name: "review", Description: "r"}}},
		"bare names":             {`["/compact","init"]`, []Command{{Name: "compact"}, {Name: "init"}}},
		"junk dropped, first duplicate kept": {
			`[{"description":"no name"},42,{"name":"a","description":"1"},{"name":"a","description":"2"}]`,
			[]Command{{Name: "a", Description: "1"}},
		},
		"null list":  {`null`, []Command{}},
		"empty list": {`[]`, []Command{}},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			got := ParseCommands(json.RawMessage(tc.in))
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("got %+v, want %+v", got, tc.want)
			}
		})
	}
	if got := ParseCommands(nil); len(got) != 0 {
		t.Fatalf("absent list = %+v", got)
	}
}
