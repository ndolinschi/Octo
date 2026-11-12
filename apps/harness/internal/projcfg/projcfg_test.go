package projcfg

import (
	"strings"
	"testing"
)

func TestValidateCommands(t *testing.T) {
	ok := []Command{
		{Name: "Dev server", Command: "pnpm dev", Pinned: true},
		{Name: "Tests", Command: "go test ./...", Cwd: "apps/harness", Pinned: true},
		{Name: "Build (release)", Command: "make build", Cwd: "lib"},
		{Name: "Тесты", Command: "make test"},
	}
	if err := ValidateCommands(append([]Command(nil), ok...)); err != nil {
		t.Fatalf("valid list: %v", err)
	}
	if err := ValidateCommands(nil); err != nil {
		t.Fatalf("empty list: %v", err)
	}
	long := strings.Repeat("a", MaxNameRunes+1)
	for name, list := range map[string][]Command{
		"no name":         {{Name: "  ", Command: "x"}},
		"long name":       {{Name: long, Command: "x"}},
		"slash in name":   {{Name: "a/b", Command: "x"}},
		"control in name": {{Name: "a\nb", Command: "x"}},
		"duplicate":       {{Name: "Dev", Command: "x"}, {Name: "dev", Command: "y"}},
		"no command":      {{Name: "a", Command: " "}},
		"huge command":    {{Name: "a", Command: strings.Repeat("x", MaxCommandLen+1)}},
		"nul in command":  {{Name: "a", Command: "x\x00y"}},
		"absolute cwd":    {{Name: "a", Command: "x", Cwd: "/etc"}},
		"dotdot cwd":      {{Name: "a", Command: "x", Cwd: "../outside"}},
		"nested dotdot":   {{Name: "a", Command: "x", Cwd: "a/../../b"}},
		"three pinned":    {{Name: "a", Command: "x", Pinned: true}, {Name: "b", Command: "x", Pinned: true}, {Name: "c", Command: "x", Pinned: true}},
	} {
		if err := ValidateCommands(list); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	tooMany := make([]Command, MaxCommands+1)
	for i := range tooMany {
		tooMany[i] = Command{Name: string(rune('a'+i%26)) + strings.Repeat("x", i/26), Command: "x"}
	}
	if err := ValidateCommands(tooMany); err == nil {
		t.Error("51 commands accepted")
	}
}

func TestValidateTrimsNamesAndParseIsForgiving(t *testing.T) {
	list := []Command{{Name: "  Tests  ", Command: "go test"}}
	if err := ValidateCommands(list); err != nil || list[0].Name != "Tests" {
		t.Fatalf("list = %+v %v", list, err)
	}
	for _, raw := range []string{"", "null", "{", `"x"`} {
		if got := ParseCommands(raw); got == nil || len(got) != 0 {
			t.Errorf("ParseCommands(%q) = %v", raw, got)
		}
	}
	got := ParseCommands(`[{"name":"A","command":"x","pinned":true}]`)
	if len(got) != 1 || !got[0].Pinned {
		t.Fatalf("parsed = %+v", got)
	}
	if c, ok := Find(got, " a "); !ok || c.Name != "A" {
		t.Fatal("Find is case-insensitive and trims")
	}
}
