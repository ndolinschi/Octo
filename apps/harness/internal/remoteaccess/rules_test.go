package remoteaccess

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func TestClassifyTable(t *testing.T) {
	cases := []struct {
		method, path string
		want         Class
	}{
		{"GET", "/v1/projects", ClassRead},
		{"GET", "/v1/projects/p1", ClassRead},
		{"GET", "/v1/projects/p1/agents/a1/messages", ClassRead},
		{"GET", "/v1/projects/p1/files/content", ClassRead},
		{"GET", "/v1/projects/p1/events/poll", ClassRead},
		{"GET", "/v1/sessions", ClassRead},
		{"GET", "/v1/config", ClassRead},
		{"POST", "/v1/projects/p1/messages", ClassSend},
		{"POST", "/v1/projects/p1/sessions/s1/messages", ClassSend},
		{"POST", "/v1/projects/p1/approvals/ap1", ClassAnswer},
		{"POST", "/v1/projects/p1/inputs/in1", ClassAnswer},
		{"POST", "/v1/projects/p1/plans/pl1/approve", ClassAnswer},
		{"POST", "/v1/projects/p1/cancel", ClassStop},
		{"POST", "/v1/projects/p1/sessions/s1/stop", ClassStop},
		// Local only.
		{"GET", "/v1/settings", ClassDeny},
		{"PUT", "/v1/settings", ClassDeny},
		{"GET", "/v1/diagnostics", ClassDeny},
		{"GET", "/v1/fs/dirs", ClassDeny},
		{"POST", "/v1/fs/pick-folder", ClassDeny},
		{"GET", "/v1/remote", ClassDeny},
		{"POST", "/v1/remote/enable", ClassDeny},
		{"POST", "/v1/providers/x/recheck", ClassDeny},
		{"POST", "/v1/projects", ClassDeny},
		{"PATCH", "/v1/projects/p1", ClassDeny},
		{"DELETE", "/v1/projects/p1", ClassDeny},
		{"GET", "/v1/projects/p1/secrets", ClassDeny},
		{"PUT", "/v1/projects/p1/secrets/K", ClassDeny},
		{"GET", "/v1/projects/p1/lsp", ClassDeny},
		{"POST", "/v1/projects/p1/lsp/ts/sessions", ClassDeny},
		{"POST", "/v1/projects/p1/browser/proxy", ClassDeny},
		{"DELETE", "/v1/projects/p1/browser/proxy", ClassDeny},
		{"POST", "/v1/projects/p1/commands/test/run", ClassDeny},
		{"PUT", "/v1/projects/p1/files/content", ClassDeny},
		{"POST", "/v1/projects/p1/changes/c1/revert", ClassDeny},
		{"POST", "/v1/projects/p1/rewind", ClassDeny},
		{"POST", "/v1/projects/p1/complete", ClassDeny},
		{"PUT", "/v1/projects/p1/memory/notes.md", ClassDeny},
		{"POST", "/v1/projects/p1/reviews/r1/submit", ClassDeny},
		{"POST", "/mcp/s1", ClassDeny},
		// Unknown routes, odd shapes.
		{"POST", "/v1/projects/p1/something-new", ClassDeny},
		{"GET", "/v1/whatever", ClassDeny},
		{"PUT", "/v1/projects/p1/x/files/content", ClassDeny},
		{"GET", "/v1/projects//agents", ClassDeny},
	}
	for _, c := range cases {
		if got, _ := Classify(c.method, c.path); got != c.want {
			t.Errorf("%s %s = %s, want %s", c.method, c.path, got, c.want)
		}
	}
}

// TestEveryBridgeRouteIsClassified reads the bridge's route table (its source) and fails for a /v1 route no rule
// names: a new route must be classified on purpose, not by the default deny.
func TestEveryBridgeRouteIsClassified(t *testing.T) {
	files, err := filepath.Glob(filepath.Join("..", "bridge", "*.go"))
	if err != nil || len(files) == 0 {
		t.Fatalf("bridge sources: %v", err)
	}
	route := regexp.MustCompile(`mux\.HandleFunc\("([A-Z]+) (/v1/[^"]*)"`)
	wild := regexp.MustCompile(`\{[^}]+\}`)
	n := 0
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		for _, m := range route.FindAllStringSubmatch(string(b), -1) {
			n++
			p := wild.ReplaceAllString(m[2], "x")
			if _, explicit := Classify(m[1], p); !explicit {
				t.Errorf("%s %s (%s) is not classified for remote devices (rules.go)", m[1], m[2], filepath.Base(f))
			}
		}
	}
	if n < 100 {
		t.Fatalf("found only %d bridge routes; the pattern no longer matches the source", n)
	}
}
