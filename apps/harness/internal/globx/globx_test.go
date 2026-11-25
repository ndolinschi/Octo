package globx

import "testing"

func TestMatch(t *testing.T) {
	for _, tc := range []struct {
		pat, name string
		want      bool
	}{
		{"*.go", "main.go", true},
		{"*.go", "a/main.go", false},
		{"**/*.go", "main.go", true},
		{"**/*.go", "a/b/main.go", true},
		{"src/**", "src/a/b.ts", true},
		{"src/**", "src", true},
		{"src/**/x.ts", "src/x.ts", true},
		{"src/**/x.ts", "src/a/b/x.ts", true},
		{"src/**/x.ts", "lib/x.ts", false},
		{"*.{ts,tsx}", "a.tsx", true},
		{"*.{ts,tsx}", "a.js", false},
		{"a/{b,c/**}/d", "a/c/e/d", true},
		{"file?.txt", "file1.txt", true},
		{"file[0-9].txt", "filex.txt", false},
		{"docs/README.md", "docs/README.md", true},
		{"docs/README.md", "docs/README.mdx", false},
	} {
		if got := Match(tc.pat, tc.name); got != tc.want {
			t.Errorf("Match(%q, %q) = %v, want %v", tc.pat, tc.name, got, tc.want)
		}
	}
}

func TestValid(t *testing.T) {
	for p, want := range map[string]bool{"**/*.go": true, "a/{b,c}": true, "a/{b": false, "a/[": false, "}": false} {
		if got := Valid(p); got != want {
			t.Errorf("Valid(%q) = %v, want %v", p, got, want)
		}
	}
}
