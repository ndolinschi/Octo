package remoteaccess

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// The web build writes the same policy into its page as a <meta> (apps/web/vite.config.ts, WEB_CSP): the two stay equal.
func TestWebBuildCSPIsTheHeader(t *testing.T) {
	src, err := os.ReadFile("../../../web/vite.config.ts")
	if err != nil {
		t.Skip("apps/web not beside the harness:", err)
	}
	m := regexp.MustCompile(`const WEB_CSP =\s*((?:"[^"]*"(?: \+\s*)?)+);`).FindSubmatch(src)
	if m == nil {
		t.Fatal("WEB_CSP not found in apps/web/vite.config.ts")
	}
	var b strings.Builder
	for _, part := range regexp.MustCompile(`"([^"]*)"`).FindAllSubmatch(m[1], -1) {
		b.Write(part[1])
	}
	if b.String() != CSP {
		t.Fatalf("apps/web WEB_CSP = %q\nharness CSP     = %q", b.String(), CSP)
	}
}
