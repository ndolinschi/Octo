package orchestrator_test

import (
	"context"
	"math"
	"os"
	"path/filepath"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/fakeacp"
	"github.com/ndolinschi/Octo/apps/harness/internal/mockllm"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

// A scripted agent sends usage_update twice (1200 then 1800 tokens in context)
// with cumulative costs; the orchestrator stores the context window and one
// usage row per update holding the token and cost increase.
func TestACPUsageUpdateMapping(t *testing.T) {
	tests := []struct {
		name       string
		prompt     string
		wantReport bool // USD cost rows expected
	}{
		{"USD cost becomes the increase per update", "[acp] summarize this repo", true},
		{"non-USD cost is ignored", "[acp] [eur] summarize this repo", false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			r := newACPRig(t, mockllm.New(0), fakeAgent("fake", true))
			dir := t.TempDir()
			if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("# usage\n"), 0o644); err != nil {
				t.Fatal(err)
			}
			pid := r.projectAt(t, dir)
			if got := r.runCollect(t, pid, tc.prompt, nil); got.status != "completed" {
				t.Fatalf("turn = %s", got.status)
			}
			child := r.acpChild(t, pid)
			if child.ContextUsed == nil || *child.ContextUsed != 1800 || child.ContextSize == nil || *child.ContextSize != 200000 {
				t.Fatalf("context = %v / %v, want 1800 / 200000", child.ContextUsed, child.ContextSize)
			}
			if child.InputTokens != 1800 {
				t.Errorf("agent total = %d, want 1800 (unchanged behaviour)", child.InputTokens)
			}

			db, err := r.store.Get(context.Background(), pid)
			if err != nil {
				t.Fatal(err)
			}
			rows, err := db.UsageRows(context.Background(), "0000", "9999", projectstore.GroupAgent)
			if err != nil {
				t.Fatal(err)
			}
			var mine []projectstore.UsageRow
			for _, row := range rows {
				if row.Key == child.ID {
					mine = append(mine, row)
				}
			}
			if len(mine) != 1 {
				t.Fatalf("rows for the acp agent = %+v, want one group", mine)
			}
			row := mine[0]
			if row.Source != projectstore.SourceACP || row.Model != "acp:fake" || row.Requests != 2 || row.InputTokens != 1800 {
				t.Fatalf("row = %+v, want 2 acp rows adding up to 1800 tokens", row)
			}
			if row.Reported != tc.wantReport {
				t.Fatalf("reported cost = %v, want %v", row.Reported, tc.wantReport)
			}
			if tc.wantReport && math.Abs(row.ReportedCostUSD-fakeacp.CostAfterEdit) > 1e-9 {
				t.Errorf("summed cost = %v, want the cumulative %v (increases 0.012 + 0.018)", row.ReportedCostUSD, fakeacp.CostAfterEdit)
			}
		})
	}
}
