package local

import (
	"context"
	"encoding/json"
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

func TestReadFile_TruncatesLargeFile(t *testing.T) {
	workspace := t.TempDir()
	big := strings.Repeat("a", tools.MaxOutputBytes+100)
	if err := os.WriteFile(filepath.Join(workspace, "big.txt"), []byte(big), 0o644); err != nil {
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
	out, isError, err := def.Handle(context.Background(), json.RawMessage(`{"path":"big.txt"}`))
	if err != nil || isError {
		t.Fatalf("Handle: err=%v isError=%v out=%s", err, isError, out)
	}
	if !strings.HasSuffix(out, "...truncated") {
		t.Fatal("expected truncation suffix")
	}
	if len(out) > tools.MaxOutputBytes+20 {
		t.Fatalf("output too long: %d", len(out))
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
