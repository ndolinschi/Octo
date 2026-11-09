package tools

import (
	"strings"
	"testing"
	"unicode/utf8"
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

func TestCapString_UTF8Boundary(t *testing.T) {
	prefix := strings.Repeat("x", MaxOutputBytes-1)
	got := CapString(prefix + "€")
	if !utf8.ValidString(got) {
		t.Fatalf("invalid utf8 after cap")
	}
	if !strings.HasSuffix(got, truncatedSuffix) {
		t.Fatal("missing suffix")
	}
	if strings.TrimSuffix(got, truncatedSuffix) != prefix {
		t.Fatalf("trimmed len = %d, want %d", len(strings.TrimSuffix(got, truncatedSuffix)), len(prefix))
	}
}
