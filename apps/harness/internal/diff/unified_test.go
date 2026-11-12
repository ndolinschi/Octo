package diff

import (
	"strings"
	"testing"
)

func TestUnified(t *testing.T) {
	old := "a\nb\nc\nd\ne\nf\ng\nh\n"
	new := "a\nb\nc\nD\nE\nf\ng\nh\n"
	got := Unified("x.txt", old, new, 2, 0)
	want := "--- a/x.txt\n+++ b/x.txt\n@@ -2,6 +2,6 @@\n b\n c\n-d\n-e\n+D\n+E\n f\n g\n"
	if got != want {
		t.Fatalf("got:\n%s\nwant:\n%s", got, want)
	}
	if Unified("x", "same\n", "same\n", 3, 0) != "" {
		t.Fatal("equal texts have no diff")
	}
	add := Unified("n.txt", "", "one\ntwo\n", 3, 0)
	if !strings.Contains(add, "+one\n+two\n") || !strings.Contains(add, "@@ -1,0 +1,2 @@") {
		t.Fatalf("new file:\n%s", add)
	}
	nonl := Unified("n.txt", "a\nb", "a\nc", 1, 0)
	if !strings.Contains(nonl, "-b\n\\ No newline at end of file\n+c\n\\ No newline at end of file") {
		t.Fatalf("no newline:\n%s", nonl)
	}
	long := Unified("big", "", strings.Repeat("line of text\n", 10_000), 3, 1000)
	if len(long) > 1100 || !strings.HasSuffix(long, "[... diff cut ...]\n") {
		t.Fatalf("cut diff len %d", len(long))
	}
}
