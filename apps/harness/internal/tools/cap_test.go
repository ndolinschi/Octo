package tools

import (
	"fmt"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestTruncate(t *testing.T) {
	tests := []struct {
		name       string
		in         string
		max        int
		wantSame   bool
		wantShown  int // bytes of input kept, when truncated
		wantMarker string
	}{
		{name: "short unchanged", in: "ok", max: 100, wantSame: true},
		{name: "exactly max unchanged", in: strings.Repeat("x", 500), max: 500, wantSame: true},
		{name: "long is cut", in: strings.Repeat("x", 5000), max: 1000, wantMarker: "of 5000 bytes"},
		{name: "multibyte boundary", in: strings.Repeat("€", 2000), max: 1001, wantMarker: "of 6000 bytes"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := Truncate(tc.in, tc.max, "HINT")
			if tc.wantSame {
				if got != tc.in {
					t.Fatalf("changed a string within the cap")
				}
				return
			}
			if len(got) > tc.max {
				t.Fatalf("len = %d, want <= %d", len(got), tc.max)
			}
			if !utf8.ValidString(got) {
				t.Fatal("invalid utf8 after cut")
			}
			i := strings.Index(got, "\n\n[truncated: ")
			if i < 0 || !strings.Contains(got, tc.wantMarker) || !strings.HasSuffix(got, "HINT]") {
				t.Fatalf("marker missing or wrong: %q", got[max(0, len(got)-200):])
			}
			if !strings.HasPrefix(tc.in, got[:i]) {
				t.Fatal("kept text is not a prefix of the input")
			}
			if want := fmt.Sprintf("showed the first %d of %d bytes; %d bytes cut", i, len(tc.in), len(tc.in)-i); !strings.Contains(got, want) {
				t.Fatalf("marker does not match kept length; want %q in %q", want, got[i:])
			}
		})
	}
}

func TestLimits(t *testing.T) {
	big := strings.Repeat("a", 300<<10)
	tests := []struct {
		name string
		lim  Limits
		fn   func(Limits, string) string
		want int // maximum output length
		hint string
	}{
		{"result default", Limits{}, Limits.CapResult, DefaultMaxResultBytes, "read_file with offset/limit"},
		{"report default", Limits{}, Limits.CapReport, DefaultMaxReportBytes, "spawn a new sub-agent"},
		{"result override", Limits{ResultBytes: 2048}, Limits.CapResult, 2048, "head, tail"},
		{"report override", Limits{ReportBytes: 4096}, Limits.CapReport, 4096, "shorter report"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := tc.fn(tc.lim, big)
			if len(got) > tc.want || len(got) < tc.want-400 {
				t.Fatalf("len = %d, want just under %d", len(got), tc.want)
			}
			if !strings.Contains(got, "of 307200 bytes") || !strings.Contains(got, tc.hint) {
				t.Fatalf("marker lacks size or hint: %q", got[len(got)-250:])
			}
		})
	}
	if got := (Limits{}).CapResult("small"); got != "small" {
		t.Fatalf("small result changed: %q", got)
	}
	if r := (Limits{ResultBytes: -1}).Resolved(); r.ResultBytes != DefaultMaxResultBytes || r.ReadLines != DefaultReadFileLines {
		t.Fatalf("Resolved = %+v", r)
	}
}

func TestCapString_Default(t *testing.T) {
	if got := CapString(strings.Repeat("x", 300<<10)); len(got) > DefaultMaxResultBytes || !strings.Contains(got, "[truncated:") {
		t.Fatalf("CapString len = %d", len(got))
	}
}
