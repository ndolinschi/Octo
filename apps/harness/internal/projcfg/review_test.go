package projcfg

import "testing"

func TestGlobMatching(t *testing.T) {
	cases := []struct {
		glob, path string
		want       bool
	}{
		{"*.snap", "a/b/c.snap", true}, // no slash: any directory
		{"*.snap", "c.snap", true},
		{"*.snap", "c.snapx", false},
		{"docs/**", "docs/a/b.md", true},
		{"docs/**", "other/docs/a.md", false},
		{"docs/", "docs/a.md", true}, // directory
		{"docs/", "docs", false},
		{"**/fixtures/**", "x/y/fixtures/z.json", true},
		{"**/fixtures/**", "fixtures/z.json", true},
		{"src/*.go", "src/a.go", true},
		{"src/*.go", "src/sub/a.go", false}, // * does not cross /
		{"src/**/*.go", "src/sub/deep/a.go", true},
		{"src/**/*.go", "src/a.go", true},
		{"/vendor/**", "vendor/x.go", true}, // leading slash anchors, same as without
		{"file?.txt", "file1.txt", true},
		{"file?.txt", "file12.txt", false},
		{"a.b", "axb", false}, // the dot is literal
		{"проект/*.md", "проект/a.md", true},
		{"(x)+.go", "(x)+.go", true}, // regexp characters are literal
	}
	for _, c := range cases {
		if got := Match(c.glob, c.path); got != c.want {
			t.Errorf("Match(%q, %q) = %v, want %v", c.glob, c.path, got, c.want)
		}
	}
	if !MatchAny([]string{"x", "*.md"}, "a/README.md") || MatchAny(nil, "a") {
		t.Error("MatchAny")
	}
}

func TestValidateReview(t *testing.T) {
	c := ReviewConfig{}
	if err := ValidateReview(&c); err != nil || c.Prefer != "auto" || c.Commands == nil || c.MechanicalGlobs == nil {
		t.Fatalf("defaults = %+v %v", c, err)
	}
	c = ReviewConfig{Commands: []string{" Tests ", "Lint"}, MechanicalGlobs: []string{" *.snap "}, Prefer: "split"}
	if err := ValidateReview(&c); err != nil || c.Commands[0] != "Tests" || c.MechanicalGlobs[0] != "*.snap" {
		t.Fatalf("valid = %+v %v", c, err)
	}
	for name, bad := range map[string]ReviewConfig{
		"prefer":     {Prefer: "side-by-side"},
		"empty name": {Commands: []string{" "}},
		"duplicate":  {Commands: []string{"a", "A"}},
		"empty glob": {MechanicalGlobs: []string{""}},
		"negation":   {MechanicalGlobs: []string{"!a"}},
		"long glob":  {MechanicalGlobs: []string{string(make([]byte, MaxGlobLen+1))}},
	} {
		b := bad
		if err := ValidateReview(&b); err == nil {
			t.Errorf("%s accepted", name)
		}
	}
	if got := ParseReview("{"); got.Prefer != "auto" || len(got.Commands) != 0 {
		t.Fatalf("unreadable = %+v", got)
	}
	if got := ParseReview(`{"prefer":"unified","mechanical_globs":["x"]}`); got.Prefer != "unified" || got.MechanicalGlobs[0] != "x" || got.Commands == nil {
		t.Fatalf("parsed = %+v", got)
	}
}
