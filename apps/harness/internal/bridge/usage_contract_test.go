package bridge_test

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

// fixtureDir holds the real /v1/usage shapes the UI and its demo bridge are built
// against. Regenerate with OCTO_UPDATE_FIXTURES=1 go test ./internal/bridge -run TestUsageContract.
const fixtureDir = "../../../../packages/agent-client/src/fixtures"

func f64(v float64) *float64 { return &v }

// The usage report as the HTTP API answers it, for an API model, a flat-rate
// (subscription) agent and both: every bucket carries flat_rate, cost_usd
// (spend; 0 for flat-rate only) and subscription_equivalent_usd.
func TestUsageContract(t *testing.T) {
	ctx := context.Background()
	api := projectstore.UsageRecord{Model: "claude-sonnet-5-5", Source: projectstore.SourceAPI, InputTokens: 1200, OutputTokens: 300, CostUSD: f64(0.0123)}
	flat := projectstore.UsageRecord{Model: "acp:grok", Source: projectstore.SourceACP, InputTokens: 5000, OutputTokens: 800, CostUSD: f64(0.5), CostEstimated: true, FlatRate: true}
	cases := []struct {
		name string
		rows []projectstore.UsageRecord
		want func(t *testing.T, buckets []map[string]any, total map[string]any)
	}{
		{"api", []projectstore.UsageRecord{api}, func(t *testing.T, b []map[string]any, total map[string]any) {
			expect(t, b[0], false, 0.0123, nil)
			expect(t, total, false, 0.0123, nil)
		}},
		{"flat", []projectstore.UsageRecord{flat}, func(t *testing.T, b []map[string]any, total map[string]any) {
			expect(t, b[0], true, 0.0, 0.5)
			expect(t, total, true, 0.0, 0.5)
		}},
		{"mixed", []projectstore.UsageRecord{api, flat}, func(t *testing.T, b []map[string]any, total map[string]any) {
			byKey := map[string]map[string]any{}
			for _, x := range b {
				byKey[x["key"].(string)] = x
			}
			expect(t, byKey["claude-sonnet-5-5"], false, 0.0123, nil)
			expect(t, byKey["acp:grok"], true, 0.0, 0.5)
			expect(t, total, false, 0.0123, 0.5) // both kinds: not flat_rate, both figures
		}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			e := newEnv(t, nil)
			var proj struct {
				ID                  string `json:"id"`
				OrchestratorAgentID string `json:"orchestrator_agent_id"`
			}
			e.into(t, "POST", "/v1/projects", map[string]any{"name": "p"}, 201, &proj)
			db, err := e.store.Get(ctx, proj.ID)
			if err != nil {
				t.Fatal(err)
			}
			for _, r := range c.rows {
				r.AgentID = proj.OrchestratorAgentID
				if _, err := db.RecordUsage(ctx, r); err != nil {
					t.Fatal(err)
				}
			}
			status, raw := e.do(t, "GET", "/v1/usage?group=model&from=2020-01-01&to=2099-01-01", nil)
			if status != 200 {
				t.Fatalf("status %d: %s", status, raw)
			}
			var rep struct {
				Buckets []map[string]any `json:"buckets"`
				Total   map[string]any   `json:"total"`
			}
			if err := json.Unmarshal(raw, &rep); err != nil {
				t.Fatal(err)
			}
			for _, b := range append(rep.Buckets, rep.Total) {
				for _, k := range []string{"flat_rate", "cost_usd", "subscription_equivalent_usd", "cost_estimated", "input_tokens"} {
					if _, ok := b[k]; !ok {
						t.Fatalf("bucket %v lacks %q", b["key"], k)
					}
				}
			}
			c.want(t, rep.Buckets, rep.Total)

			path := filepath.Join(fixtureDir, "usage."+c.name+".json")
			var pretty bytes.Buffer
			if err := json.Indent(&pretty, bytes.TrimSpace(raw), "", "  "); err != nil {
				t.Fatal(err)
			}
			pretty.WriteByte('\n')
			if os.Getenv("OCTO_UPDATE_FIXTURES") != "" {
				if err := os.MkdirAll(fixtureDir, 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(path, pretty.Bytes(), 0o644); err != nil {
					t.Fatal(err)
				}
				return
			}
			have, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("fixture %s missing: run with OCTO_UPDATE_FIXTURES=1 (%v)", path, err)
			}
			var a, b any
			if json.Unmarshal(have, &a) != nil || json.Unmarshal(raw, &b) != nil || !reflect.DeepEqual(a, b) {
				t.Fatalf("fixture %s differs from the API response; regenerate with OCTO_UPDATE_FIXTURES=1\nfixture: %s\nresponse: %s", path, have, raw)
			}
		})
	}
}

func expect(t *testing.T, b map[string]any, flat bool, cost float64, sub any) {
	t.Helper()
	if b["flat_rate"] != flat {
		t.Fatalf("%v flat_rate = %v, want %v", b["key"], b["flat_rate"], flat)
	}
	if got, ok := b["cost_usd"].(float64); !ok || got != cost {
		t.Fatalf("%v cost_usd = %v, want %v (never null here)", b["key"], b["cost_usd"], cost)
	}
	switch want := sub.(type) {
	case nil:
		if b["subscription_equivalent_usd"] != nil {
			t.Fatalf("%v subscription_equivalent_usd = %v, want null", b["key"], b["subscription_equivalent_usd"])
		}
	case float64:
		if got, ok := b["subscription_equivalent_usd"].(float64); !ok || got != want {
			t.Fatalf("%v subscription_equivalent_usd = %v, want %v", b["key"], b["subscription_equivalent_usd"], want)
		}
	}
}
