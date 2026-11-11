package activity

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestForTool(t *testing.T) {
	for _, c := range []struct{ name, in, want string }{
		{"read_file", `{"path":"src/x.go"}`, "Reading src/x.go"},
		{"write_file", `{"path":"a/b.txt","content":"x"}`, "Writing a/b.txt"},
		{"list_dir", `{"path":"."}`, "Listing the project folder"},
		{"list_dir", `{}`, "Listing the project folder"},
		{"bash", `{"command":"pnpm test\nsecond line"}`, "Running `pnpm test second line`"},
		{"bash", `{"command":"echo ` + "`x`" + `"}`, "Running `echo 'x'`"},
		{"search_files", `{"pattern":"budget"}`, `Searching for "budget"`},
		{"spawn_agent", `{"title":"Fix the bug","task":"long"}`, "Delegating: Fix the bug"},
		{"spawn_agent", `{"task":"do it"}`, "Delegating: do it"},
		{"memory_search", `{"query":"port"}`, `Searching memory for "port"`},
		{"request_input", `{}`, "Asking you for input"},
		{"mystery", `{}`, "Using mystery"},
		{"read_file", `not json`, "Reading the project folder"},
	} {
		if got := ForTool(c.name, json.RawMessage(c.in)); got != c.want {
			t.Errorf("%s %s = %q, want %q", c.name, c.in, got, c.want)
		}
	}
	long := strings.Repeat("я", 200)
	if got := ForTool("bash", json.RawMessage(`{"command":"`+long+`"}`)); len([]rune(got)) > 80 || !strings.Contains(got, "…") {
		t.Errorf("long command label = %q", got)
	}
}

func TestForACP(t *testing.T) {
	for _, c := range []struct{ kind, title, loc, cwd, want string }{
		{"read", "Read file", "/p/src/x.go", "/p", "Reading src/x.go"},
		{"read", "Read file", "/elsewhere/x.go", "/p", "Reading /elsewhere/x.go"},
		{"edit", "Edit", "/p/a.go", "/p", "Editing a.go"},
		{"execute", "`pnpm test`", "", "/p", "Running `pnpm test`"},
		{"execute", "", "", "/p", "Running a command"},
		{"search", "grep budget", "", "", "grep budget"},
		{"think", "", "", "", "Thinking"},
		{"other", "Task: review", "", "", "Task: review"},
		{"", "", "", "", "Using a tool"},
		{"read", "Read file", "", "", "Read file"},
	} {
		if got := ForACP(c.kind, c.title, c.loc, c.cwd); got != c.want {
			t.Errorf("%+v = %q, want %q", c, got, c.want)
		}
	}
}
