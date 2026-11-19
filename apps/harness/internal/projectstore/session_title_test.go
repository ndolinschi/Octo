package projectstore

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestSessionTitle(t *testing.T) {
	long := "Run the API tests and lint, then raise the HTTP retry limit to 5 and log each retry with its delay"
	cases := []struct{ name, in, want string }{
		{"empty", "  \n ", "New session"},
		{"first line", "Fix the flaky test\nmore detail", "Fix the flaky test"},
		{"exactly 80", strings.Repeat("a", 80), strings.Repeat("a", 80)},
		{"cut at a space", long, "Run the API tests and lint, then raise the HTTP retry limit to 5 and log each…"},
		{"space right after 80", strings.Repeat("a", 80) + " tail", strings.Repeat("a", 80) + "…"},
		{"one long word", strings.Repeat("b", 90), strings.Repeat("b", 80) + "…"},
		{"punctuation before the cut", strings.Repeat("c", 70) + ", then more words here to pass", strings.Repeat("c", 70) + ", then…"},
	}
	for _, c := range cases {
		got := SessionTitle(c.in)
		if got != c.want {
			t.Errorf("%s: SessionTitle = %q, want %q", c.name, got, c.want)
		}
		if n := utf8.RuneCountInString(got); n > 81 {
			t.Errorf("%s: %d characters", c.name, n)
		}
	}
	// Multi-byte text is cut by characters, not bytes.
	ru := strings.Repeat("привет ", 15)
	if got := SessionTitle(ru); !strings.HasSuffix(got, "привет…") || utf8.RuneCountInString(got) > 81 {
		t.Errorf("multibyte: %q", got)
	}
}
