package tools

import (
	"strings"
	"testing"
)

func TestCapString(t *testing.T) {
	short := "ok"
	if got := CapString(short); got != short {
		t.Fatalf("CapString short = %q", got)
	}
	long := strings.Repeat("x", MaxOutputBytes+10)
	got := CapString(long)
	if len(got) != MaxOutputBytes+len(truncatedSuffix) {
		t.Fatalf("len = %d", len(got))
	}
	if !strings.HasSuffix(got, truncatedSuffix) {
		t.Fatalf("missing suffix")
	}
}
