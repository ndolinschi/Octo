package inputs

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"testing"
)

// Criterion 8 (Go side): CheckAnswer refuses exactly the ids the shared
// fixture lists (the client's check reads the same file).
func TestSharedFormsFixture(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "packages", "agent-client", "src", "fixtures", "forms.json"))
	if err != nil {
		t.Skipf("shared fixture not present: %v", err)
	}
	var fx struct {
		Forms map[string]json.RawMessage `json:"forms"`
		Cases []struct {
			Name   string         `json:"name"`
			Form   string         `json:"form"`
			Values map[string]any `json:"values"`
			Skip   bool           `json:"skip"`
			Errors []string       `json:"errors"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatal(err)
	}
	schemas := map[string]Schema{}
	for name, f := range fx.Forms {
		s, err := ParseSchema(f, OriginTool)
		if err != nil {
			t.Errorf("form %s does not parse: %v", name, err)
			continue
		}
		schemas[name] = s
	}
	for i, c := range fx.Cases {
		s, ok := schemas[c.Form]
		if !ok {
			continue
		}
		_, errs := CheckAnswer(s, Answer{Skip: c.Skip, Values: c.Values})
		got := []string{}
		for id := range errs {
			got = append(got, id)
		}
		sort.Strings(got)
		want := slices.Clone(c.Errors)
		if want == nil {
			want = []string{}
		}
		sort.Strings(want)
		if !slices.Equal(got, want) {
			t.Errorf("case %d %q (%s): refused %v, fixture says %v (%v)", i, c.Name, c.Form, got, want, errs)
		}
	}
}
