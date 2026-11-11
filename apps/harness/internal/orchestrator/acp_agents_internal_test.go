package orchestrator

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
)

func TestSpawnSchemaModel(t *testing.T) {
	listed := func(id string, models ...string) plugins.Agent {
		return plugins.Agent{ID: id, Label: id, Models: models}
	}
	tests := []struct {
		name     string
		agents   []plugins.Agent
		wantProp bool
		wantEnum []string
		wantDesc string
	}{
		{"no agents, no model", nil, false, nil, ""},
		{"agent without a list is free text", []plugins.Agent{listed("a")}, true, nil, ""},
		{"all list: union enum", []plugins.Agent{listed("a", "x", "y"), listed("b", "y", "z")}, true, []string{"x", "y", "z"}, "a: x, y; b: y, z"},
		{"mixed: no enum, still described", []plugins.Agent{listed("a", "x"), listed("b")}, true, nil, "a: x"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			raw, err := spawnSchema(tc.agents)
			if err != nil {
				t.Fatal(err)
			}
			var s struct {
				Properties map[string]struct {
					Enum        []string `json:"enum"`
					Description string   `json:"description"`
				} `json:"properties"`
				Required []string `json:"required"`
			}
			if err := json.Unmarshal(raw, &s); err != nil {
				t.Fatal(err)
			}
			m, ok := s.Properties["model"]
			if ok != tc.wantProp {
				t.Fatalf("model property present = %v, want %v", ok, tc.wantProp)
			}
			if !reflect.DeepEqual(m.Enum, tc.wantEnum) || !strings.Contains(m.Description, tc.wantDesc) {
				t.Fatalf("model = %+v, want enum %v and %q in the description", m, tc.wantEnum, tc.wantDesc)
			}
			for _, req := range s.Required {
				if req == "model" {
					t.Fatal("model must stay optional")
				}
			}
		})
	}
}

func TestACPTargetRecorded(t *testing.T) {
	tests := []struct {
		model, want string
	}{{"", "acp:fake"}, {"beta", "acp:fake/beta"}, {"vendor/m-2", "acp:fake/vendor/m-2"}}
	for _, tc := range tests {
		got := acpTarget{agent: plugins.Agent{ID: "fake"}, model: tc.model}.recorded()
		if got != tc.want {
			t.Errorf("recorded(%q) = %q, want %q", tc.model, got, tc.want)
		}
	}
}
