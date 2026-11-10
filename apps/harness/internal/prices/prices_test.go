package prices

import (
	"math"
	"os"
	"path/filepath"
	"testing"
)

const sample = `
# harness prices
[models."claude-opus-5-5"]
input = 5.0        # USD per 1M tokens
output = 25.0
cache_read = 0.5
cache_write = 6.25

[models.cheap-model]
input = 1
output = 2
`

func TestEstimate(t *testing.T) {
	tab, err := Parse(sample)
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name   string
		model  string
		tok    Tokens
		want   float64
		wantOK bool
	}{
		{"all four parts", "claude-opus-5-5", Tokens{1_000_000, 100_000, 2_000_000, 400_000}, 5 + 2.5 + 1 + 2.5, true},
		{"cache falls back to input price", "cheap-model", Tokens{1_000_000, 0, 1_000_000, 1_000_000}, 3, true},
		{"unpriced model is unknown, not zero", "other", Tokens{Input: 100}, 0, false},
		{"zero tokens priced is zero", "cheap-model", Tokens{}, 0, true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := tab.Estimate(tc.model, tc.tok)
			if ok != tc.wantOK || math.Abs(got-tc.want) > 1e-9 {
				t.Fatalf("Estimate = %v, %v; want %v, %v", got, ok, tc.want, tc.wantOK)
			}
		})
	}
}

func TestParseErrors(t *testing.T) {
	tests := map[string]string{
		"key before table":   "input = 1\n",
		"missing output":     "[models.m]\ninput = 1\n",
		"not a number":       "[models.m]\ninput = abc\noutput = 1\n",
		"negative":           "[models.m]\ninput = -1\noutput = 1\n",
		"foreign table":      "[providers.x]\ninput = 1\n",
		"unquoted odd id":    "[models.a.b]\ninput = 1\noutput = 1\n",
		"duplicate model":    "[models.m]\ninput = 1\noutput = 1\n[models.m]\ninput = 1\noutput = 1\n",
		"unterminated":       "[models.m\n",
		"line without equal": "[models.m]\ninput 1\n",
	}
	for name, src := range tests {
		t.Run(name, func(t *testing.T) {
			if _, err := Parse(src); err == nil {
				t.Fatal("accepted malformed table")
			}
		})
	}
}

func TestLoad(t *testing.T) {
	dir := t.TempDir()
	if tab, err := Load(filepath.Join(dir, File)); err != nil || tab.Len() != 0 {
		t.Fatalf("missing file = %d models, %v; want empty table, nil", tab.Len(), err)
	}
	path := filepath.Join(dir, File)
	if err := os.WriteFile(path, []byte(sample), 0o600); err != nil {
		t.Fatal(err)
	}
	if tab, err := Load(path); err != nil || tab.Len() != 2 {
		t.Fatalf("valid file = %d models, %v", tab.Len(), err)
	}
	if err := os.WriteFile(path, []byte("[models.m]\ninput = x\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if tab, err := Load(path); err == nil || tab.Len() != 0 {
		t.Fatalf("malformed file = %d models, %v; want empty table and an error", tab.Len(), err)
	}
}
