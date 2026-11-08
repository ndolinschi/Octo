package local

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ndolinschi/Octo/harness/internal/tools"
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
