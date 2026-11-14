package local

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/tools"
)

func TestReadFile_RejectsEscape(t *testing.T) {
	workspace := t.TempDir()

	reg := tools.NewRegistry()
	if err := Register(reg, workspace); err != nil {
		t.Fatalf("Register: %v", err)
	}
	def, ok := reg.Get("read_file")
	if !ok {
		t.Fatal("read_file not registered")
	}

	output, isError, err := def.Handle(context.Background(), json.RawMessage(`{"path":"../outside"}`))
	if err != nil {
		t.Fatalf("Handle err: %v", err)
	}
	if !isError {
		t.Fatalf("expected isError true, output=%q", output)
	}
}

func TestReadFile_RejectsSymlinkEscape(t *testing.T) {
	workspace := t.TempDir()
	outsideDir := t.TempDir()
	secret := filepath.Join(outsideDir, "secret.txt")
	if err := os.WriteFile(secret, []byte("leaked"), 0o644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(workspace, "escape")
	if err := os.Symlink(secret, link); err != nil {
		t.Fatal(err)
	}

	reg := tools.NewRegistry()
	if err := Register(reg, workspace); err != nil {
		t.Fatalf("Register: %v", err)
	}
	def, ok := reg.Get("read_file")
	if !ok {
		t.Fatal("read_file not registered")
	}

	output, isError, err := def.Handle(context.Background(), json.RawMessage(`{"path":"escape"}`))
	if err != nil {
		t.Fatalf("Handle err: %v", err)
	}
	if !isError {
		t.Fatalf("expected isError true, output=%q", output)
	}
}

func TestListDir_RejectsInvalidJSON(t *testing.T) {
	workspace := t.TempDir()
	reg := tools.NewRegistry()
	if err := Register(reg, workspace); err != nil {
		t.Fatalf("Register: %v", err)
	}
	def, ok := reg.Get("list_dir")
	if !ok {
		t.Fatal("list_dir not registered")
	}

	_, isError, err := def.Handle(context.Background(), json.RawMessage(`{not-json`))
	if err != nil {
		t.Fatalf("Handle err: %v", err)
	}
	if !isError {
		t.Fatal("expected isError true for invalid JSON")
	}
}

func TestWriteReadRoundTrip(t *testing.T) {
	workspace := t.TempDir()
	reg := tools.NewRegistry()
	if err := Register(reg, workspace); err != nil {
		t.Fatalf("Register: %v", err)
	}
	write, ok := reg.Get("write_file")
	if !ok {
		t.Fatal("write_file not registered")
	}
	read, ok := reg.Get("read_file")
	if !ok {
		t.Fatal("read_file not registered")
	}

	ctx := context.Background()
	_, isError, err := write.Handle(ctx, json.RawMessage(`{"path":"notes/hello.txt","content":"round-trip"}`))
	if err != nil {
		t.Fatalf("write Handle err: %v", err)
	}
	if isError {
		t.Fatal("write returned isError")
	}

	output, isError, err := read.Handle(ctx, json.RawMessage(`{"path":"notes/hello.txt"}`))
	if err != nil {
		t.Fatalf("read Handle err: %v", err)
	}
	if isError {
		t.Fatalf("read isError: %s", output)
	}
	if !strings.Contains(output, "round-trip") {
		t.Fatalf("output %q missing content", output)
	}
}

func readFileTool(t *testing.T, lim tools.Limits, files map[string]string) tools.Def {
	t.Helper()
	workspace := t.TempDir()
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(workspace, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	reg := tools.NewRegistry()
	if err := RegisterRootsLimits(reg, []Root{{Label: "w", Path: workspace}}, lim); err != nil {
		t.Fatalf("Register: %v", err)
	}
	def, ok := reg.Get("read_file")
	if !ok {
		t.Fatal("read_file not registered")
	}
	return def
}

func numberedLines(n int) string {
	var b strings.Builder
	for i := 1; i <= n; i++ {
		fmt.Fprintf(&b, "line %d\n", i)
	}
	return b.String()
}

func TestReadFile_OffsetLimit(t *testing.T) {
	five := numberedLines(5)
	def := readFileTool(t, tools.Limits{ReadLines: 3}, map[string]string{
		"five.txt": five, "empty.txt": "", "nonl.txt": "a\nb", "long.txt": numberedLines(5000),
		"huge-line.txt": strings.Repeat("z", 200<<10) + "\nnext\n",
	})
	tests := []struct {
		name     string
		input    string
		want     string // exact output, or prefix when wantPrefix
		isErr    bool
		contains []string
	}{
		{name: "default limit applies and reports total", input: `{"path":"five.txt"}`,
			want: "line 1\nline 2\nline 3\n", contains: []string{"showed lines 1-3 of 5 total", "offset=4"}},
		{name: "explicit limit within file", input: `{"path":"five.txt","limit":5}`, want: five},
		{name: "offset and limit", input: `{"path":"five.txt","offset":2,"limit":2}`,
			want: "line 2\nline 3\n", contains: []string{"showed lines 2-3 of 5 total", "offset=4"}},
		{name: "offset to the end is complete", input: `{"path":"five.txt","offset":4,"limit":10}`, want: "line 4\nline 5\n"},
		{name: "continuation hint works", input: `{"path":"five.txt","offset":4}`, want: "line 4\nline 5\n"},
		{name: "offset past end", input: `{"path":"five.txt","offset":6}`, isErr: true, contains: []string{"past the end", "5 lines"}},
		{name: "negative offset", input: `{"path":"five.txt","offset":-1}`, isErr: true, contains: []string{"must be positive"}},
		{name: "empty file", input: `{"path":"empty.txt"}`, want: ""},
		{name: "no trailing newline", input: `{"path":"nonl.txt"}`, want: "a\nb"},
		{name: "byte cap inside the line window", input: `{"path":"long.txt","limit":5000}`,
			contains: []string{"showed lines 1-", "of 5000 total"}},
		{name: "single huge line is clipped", input: `{"path":"huge-line.txt"}`,
			contains: []string{"showed lines 1-1 of 2 total", "offset=2"}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			out, isErr, err := def.Handle(context.Background(), json.RawMessage(tc.input))
			if err != nil {
				t.Fatal(err)
			}
			if isErr != tc.isErr {
				t.Fatalf("isError = %v, out = %q", isErr, out)
			}
			switch {
			case tc.isErr:
			case len(tc.contains) == 0:
				if out != tc.want {
					t.Fatalf("out = %q, want %q", out, tc.want)
				}
			case tc.want != "":
				if !strings.HasPrefix(out, tc.want) {
					t.Fatalf("out = %q, want prefix %q", out, tc.want)
				}
			}
			for _, c := range tc.contains {
				if !strings.Contains(out, c) {
					t.Fatalf("out %q lacks %q", out[max(0, len(out)-200):], c)
				}
			}
			if len(out) > tools.DefaultMaxResultBytes {
				t.Fatalf("out is %d bytes, over the result cap", len(out))
			}
		})
	}
}

func TestReadFile_DefaultLimitIs2000Lines(t *testing.T) {
	def := readFileTool(t, tools.Limits{}, map[string]string{"big.txt": numberedLines(5000)})
	out, isErr, err := def.Handle(context.Background(), json.RawMessage(`{"path":"big.txt"}`))
	if err != nil || isErr {
		t.Fatalf("err=%v isErr=%v", err, isErr)
	}
	// 2000 short lines fit the byte cap, so the line limit is what cuts.
	if !strings.Contains(out, "showed lines 1-2000 of 5000 total") || !strings.Contains(out, "offset=2001") {
		t.Fatalf("tail = %q", out[len(out)-200:])
	}
}

func TestReadFile_TruncatesLargeFile(t *testing.T) {
	big := strings.Repeat("a", 300<<10)
	def := readFileTool(t, tools.Limits{}, map[string]string{"big.txt": big})
	out, isErr, err := def.Handle(context.Background(), json.RawMessage(`{"path":"big.txt"}`))
	if err != nil || isErr {
		t.Fatalf("Handle: err=%v isError=%v", err, isErr)
	}
	if len(out) > tools.DefaultMaxResultBytes {
		t.Fatalf("output %d bytes, over %d", len(out), tools.DefaultMaxResultBytes)
	}
	if !strings.Contains(out, "showed lines 1-1 of 1 total") {
		t.Fatalf("tail = %q", out[len(out)-200:])
	}
}

func TestBashEcho(t *testing.T) {
	workspace := t.TempDir()
	reg := tools.NewRegistry()
	if err := Register(reg, workspace); err != nil {
		t.Fatalf("Register: %v", err)
	}
	def, ok := reg.Get("bash")
	if !ok {
		t.Fatal("bash not registered")
	}

	output, isError, err := def.Handle(context.Background(), json.RawMessage(`{"command":"echo hi"}`))
	if err != nil {
		t.Fatalf("Handle err: %v", err)
	}
	if isError {
		t.Fatalf("isError: %s", output)
	}
	if !strings.Contains(output, "hi") {
		t.Fatalf("output %q missing hi", output)
	}
}

func TestRegisterRoots_FolderSelectionAndConfinement(t *testing.T) {
	a, b := t.TempDir(), t.TempDir()
	if err := os.WriteFile(filepath.Join(a, "a.txt"), []byte("from-a"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(b, "b.txt"), []byte("from-b"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(b, filepath.Join(a, "link")); err != nil {
		t.Fatal(err)
	}
	reg := tools.NewRegistry()
	roots := []Root{{Label: "alpha", Path: a}, {Label: "beta", Path: b}}
	if err := RegisterRoots(reg, roots, ToolReadFile, ToolListDir); err != nil {
		t.Fatalf("RegisterRoots: %v", err)
	}
	if _, ok := reg.Get(ToolBash); ok {
		t.Fatal("bash registered but not requested")
	}
	cases := []struct {
		name, tool, input string
		wantErr           bool
		wantOut           string
	}{
		{"default first folder", ToolReadFile, `{"path":"a.txt"}`, false, "from-a"},
		{"explicit second folder", ToolReadFile, `{"path":"b.txt","folder":"beta"}`, false, "from-b"},
		{"file in wrong folder", ToolReadFile, `{"path":"b.txt","folder":"alpha"}`, true, ""},
		{"unknown folder", ToolReadFile, `{"path":"a.txt","folder":"nope"}`, true, "unknown folder"},
		{"dotdot", ToolReadFile, `{"path":"../x","folder":"beta"}`, true, ""},
		{"symlink escape", ToolReadFile, `{"path":"link/b.txt"}`, true, "escapes"},
		{"list second root", ToolListDir, `{"folder":"beta"}`, false, "b.txt"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			def, _ := reg.Get(tc.tool)
			out, isErr, err := def.Handle(context.Background(), json.RawMessage(tc.input))
			if err != nil {
				t.Fatalf("Handle: %v", err)
			}
			if isErr != tc.wantErr {
				t.Fatalf("isError = %v, want %v (out=%q)", isErr, tc.wantErr, out)
			}
			if !strings.Contains(out, tc.wantOut) {
				t.Fatalf("out = %q, want substring %q", out, tc.wantOut)
			}
		})
	}
}

func TestRegisterRoots_NoRootsRegistersNothing(t *testing.T) {
	reg := tools.NewRegistry()
	if err := RegisterRoots(reg, nil); err != nil {
		t.Fatal(err)
	}
	if len(reg.All()) != 0 {
		t.Fatal("expected no tools without folders")
	}
}

func TestSearchFiles(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	write := func(rel, content string) {
		t.Helper()
		p := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("a.txt", "alpha\nneedle one\nomega\n")
	write("sub/b.go", "package b\n// needle two\n")
	write(".git/config", "needle in git\n")
	write("node_modules/x.js", "needle in deps\n")
	write("bin.dat", "needle\x00binary")
	write("many.txt", strings.Repeat("needle\n", 10))
	if err := os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("needle secret\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(outside, "secret.txt"), filepath.Join(root, "link.txt")); err != nil {
		t.Fatal(err)
	}

	reg := tools.NewRegistry()
	if err := RegisterRoots(reg, []Root{{Label: "w", Path: root}}, ToolSearchFiles); err != nil {
		t.Fatal(err)
	}
	if got := len(reg.All()); got != 1 {
		t.Fatalf("tools = %d, want only search_files", got)
	}
	def, _ := reg.Get(ToolSearchFiles)
	for _, tc := range []struct {
		name, in string
		isErr    bool
		has, not []string
	}{
		{"finds across files", `{"pattern":"needle (one|two)"}`, false, []string{"a.txt:2: needle one", "sub/b.go:2: // needle two"}, []string{"many.txt"}},
		{"skips .git, node_modules, binaries and symlinks", `{"pattern":"needle","max_results":200}`, false, []string{"many.txt:1: needle"}, []string{".git", "node_modules", "bin.dat", "link.txt", "secret"}},
		{"limits results", `{"pattern":"needle","path":"many.txt","max_results":3}`, false, []string{"stopped at 3 matching lines"}, nil},
		{"scoped to a directory", `{"pattern":"needle","path":"sub"}`, false, []string{"sub/b.go"}, []string{"a.txt"}},
		{"no matches", `{"pattern":"zzzz"}`, false, []string{"no matches"}, nil},
		{"bad regex", `{"pattern":"("}`, true, nil, nil},
		{"empty pattern", `{"pattern":""}`, true, nil, nil},
		{"escape refused", `{"pattern":"x","path":"../"}`, true, nil, nil},
		{"symlink as path refused", `{"pattern":"needle","path":"link.txt"}`, true, nil, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			out, isErr, err := def.Handle(context.Background(), json.RawMessage(tc.in))
			if err != nil || isErr != tc.isErr {
				t.Fatalf("out=%q isErr=%v err=%v", out, isErr, err)
			}
			for _, s := range tc.has {
				if !strings.Contains(out, s) {
					t.Errorf("output lacks %q:\n%s", s, out)
				}
			}
			for _, s := range tc.not {
				if strings.Contains(out, s) {
					t.Errorf("output has %q:\n%s", s, out)
				}
			}
		})
	}
}

func TestBashDoesNotSeeSecrets(t *testing.T) {
	for k, v := range map[string]string{
		"OPENROUTER_API_KEY": "sk-or-leak", "ANTHROPIC_API_KEY": "sk-ant-leak",
		"GITHUB_TOKEN": "ghp-leak", "MISTRAL_API_KEY": "mi-leak", "UNKNOWN_FAKE_VAR": "unknown-leak",
	} {
		t.Setenv(k, v)
	}
	t.Setenv("PATH", os.Getenv("PATH")) // keep PATH explicit in the test
	workspace := t.TempDir()
	reg := tools.NewRegistry()
	if err := Register(reg, workspace); err != nil {
		t.Fatalf("Register: %v", err)
	}
	def, _ := reg.Get("bash")
	output, isError, err := def.Handle(context.Background(), json.RawMessage(`{"command":"env"}`))
	if err != nil || isError {
		t.Fatalf("env: %v %v %s", err, isError, output)
	}
	for _, leak := range []string{"sk-or-leak", "sk-ant-leak", "ghp-leak", "mi-leak", "unknown-leak", "OPENROUTER_API_KEY"} {
		if strings.Contains(output, leak) {
			t.Fatalf("bash saw %q:\n%s", leak, output)
		}
	}
	if !strings.Contains(output, "PATH=") {
		t.Fatalf("PATH missing from bash environment:\n%s", output)
	}
}

// A failed command's result always ends with how it ended ("exit status N"), with output or without, and a long
// output is cut so the line survives the result cap (the UI reads "Failed (exit N)" from it).
func TestBashFailureEndsWithTheExitStatus(t *testing.T) {
	workspace := t.TempDir()
	reg := tools.NewRegistry()
	lim := tools.Limits{ResultBytes: 2048}
	if err := RegisterRootsLimits(reg, []Root{{Path: workspace}}, lim, ToolBash); err != nil {
		t.Fatal(err)
	}
	def, _ := reg.Get("bash")
	for _, tc := range []struct{ name, cmd, want string }{
		{"no output", "exit 3", "exit status 3"},
		{"output", "echo partial; echo oops >&2; exit 2", "oops\nexit status 2"},
		{"output without a newline", "printf done; exit 1", "done\nexit status 1"},
		{"long output", "yes line | head -c 100000; exit 4", "exit status 4"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			out, isErr, err := def.Handle(context.Background(), json.RawMessage(fmt.Sprintf(`{"command":%q}`, tc.cmd)))
			if err != nil || !isErr {
				t.Fatalf("err %v isError %v", err, isErr)
			}
			if !strings.HasSuffix(out, tc.want) {
				t.Fatalf("result does not end with %q: %q", tc.want, out[max(0, len(out)-200):])
			}
			if capped := lim.CapResult(out); !strings.HasSuffix(capped, "exit status "+tc.want[len(tc.want)-1:]) || len(out) > 2048 {
				t.Fatalf("the cap cuts the exit line (len %d)", len(out))
			}
		})
	}
	out, isErr, _ := def.Handle(context.Background(), json.RawMessage(`{"command":"echo fine"}`))
	if isErr || strings.Contains(out, "exit status") {
		t.Fatalf("a successful command = %q %v", out, isErr)
	}
}
