package completion

import (
	"strings"
	"testing"
)

func TestValidate(t *testing.T) {
	ok := Request{Path: "a.go", Prefix: strings.Repeat("x", MaxPrefix), Suffix: strings.Repeat("y", MaxSuffix)}
	if err := ok.Validate(); err != nil {
		t.Fatal(err)
	}
	for name, r := range map[string]Request{
		"no path":       {},
		"long prefix":   {Path: "a", Prefix: strings.Repeat("x", MaxPrefix+1)},
		"long suffix":   {Path: "a", Suffix: strings.Repeat("x", MaxSuffix+1)},
		"max lines":     {Path: "a", MaxLines: 99},
		"snippets":      {Path: "a", Snippets: make([]Snippet, 4)},
		"long snippet":  {Path: "a", Snippets: []Snippet{{Text: strings.Repeat("x", MaxSnippet+1)}}},
		"long language": {Path: "a", Language: strings.Repeat("x", 99)},
	} {
		if err := r.Validate(); err == nil {
			t.Errorf("%s was accepted", name)
		}
	}
	// Characters, not bytes: Cyrillic at the limit is fine.
	if err := (Request{Path: "a", Prefix: strings.Repeat("я", MaxPrefix)}).Validate(); err != nil {
		t.Errorf("a prefix of %d Cyrillic characters: %v", MaxPrefix, err)
	}
}

func TestNeverSent(t *testing.T) {
	for _, p := range []string{".env", "app/.env.local", "cfg/.ENV.production", "certs/server.pem", "k/private.key", "home/.ssh/id_ed25519", "id_rsa", ".git/config", "sub/.git/hooks/pre-commit", `win\.git\HEAD`} {
		if NeverSent(p, 10) == "" {
			t.Errorf("%s may be sent", p)
		}
	}
	for _, p := range []string{"src/main.go", "environment.go", "keyboard.ts", "docs/idea.md", ".gitignore", ".github/ci.yml", "my.envrc.md"} {
		if why := NeverSent(p, 10); why != "" {
			t.Errorf("%s refused: %s", p, why)
		}
	}
	if NeverSent("big.go", MaxFileBytes+1) == "" || NeverSent("ok.go", MaxFileBytes) != "" {
		t.Error("the 1 MB limit")
	}
	if NeverSent("a.bin", 5, "text", "bin\x00ary") != "binary" {
		t.Error("a NUL byte means binary")
	}
	if NeverSent("a.go", -1) != "" {
		t.Error("an unknown size is allowed")
	}
}

func TestClean(t *testing.T) {
	cases := []struct {
		name, raw, prefix, suffix string
		lines                     int
		want                      string
	}{
		{"plain", "foo(a, b)", "x := ", "", 8, "foo(a, b)"},
		{"fenced", "```go\nfoo(a)\n```", "x := ", "", 8, "foo(a)"},
		{"fence without language", "```\nfoo(a)\n```\n", "x := ", "", 8, "foo(a)"},
		{"echoed prefix tail", "x := foo(a)", "x := ", "", 8, "foo(a)"},
		{"echoed longer prefix", "func add(a, b int) int {\n\treturn a + b", "package p\n\nfunc add(a, b int) int {\n", "", 8, "\treturn a + b"},
		{"echoed suffix head", "foo(a)\n}\n", "x := ", "\n}\n", 8, "foo(a)"},
		{"repeats the next line", "return nil", "if err != nil {\n\t", "\nreturn nil\n}", 8, ""},
		{"stops at a blank line", "a := 1\nb := 2\n\nc := 3", "x := 0\n", "", 8, "a := 1\nb := 2"},
		{"blank line kept in an empty block", "a := 1\n\nb := 2", "func f() {\n", "", 8, "a := 1\n\nb := 2"},
		{"after an opening brace", "a := 1\n\nb := 2", "if ok {", "", 8, "a := 1\n\nb := 2"},
		{"max lines", "1\n2\n3\n4\n5", "func f() {\n", "", 3, "1\n2\n3"},
		{"leading newline after a newline", "\n\tx()", "func f() {\n", "", 8, "\tx()"},
		{"empty", "  \n", "a", "", 8, ""},
		{"only a fence", "```", "a", "", 8, ""},
		{"CRLF", "a\r\nb", "func f() {\n", "", 8, "a\nb"},
	}
	for _, c := range cases {
		if got := Clean(c.raw, c.prefix, c.suffix, c.lines); got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
}

func TestPromptAndStops(t *testing.T) {
	u := UserMessage(Request{Path: "a.go", Language: "go", Prefix: "x := ", Suffix: "\n}", Snippets: []Snippet{{Path: "b.go", Text: "func b() {}"}}})
	for _, want := range []string{`<file path="a.go" language="go">`, "<prefix>x := </prefix><cursor/><suffix>\n}</suffix>", `<snippet path="b.go">`} {
		if !strings.Contains(u, want) {
			t.Errorf("prompt lacks %q:\n%s", want, u)
		}
	}
	if len(StopSequences("x := ")) != 1 || StopSequences("func f() {\n") != nil || StopSequences("if a {") != nil {
		t.Error("stop sequences")
	}
}
