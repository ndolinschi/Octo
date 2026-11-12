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

const secretToken = "tok-0123456789abcdef-secret"

// A project folder that contains the data directory (a folder picked as $HOME,
// say) must not reach the API token through the file tools.
func TestProtectedDataDirIsClosedToTheFileTools(t *testing.T) {
	root := t.TempDir()
	data := filepath.Join(root, "data")
	if err := os.MkdirAll(data, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(data, "api-token"), []byte(secretToken+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "ok.txt"), []byte("needle "+secretToken+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(data, filepath.Join(root, "via-link")); err != nil {
		t.Fatal(err)
	}
	ProtectDir(data)

	for _, rel := range []string{"data", "data/api-token", "via-link/api-token", "via-link", "data/../data/api-token"} {
		if _, err := Resolve(root, rel); err == nil || !strings.Contains(err.Error(), "data directory") {
			t.Errorf("Resolve(%q) = %v, want a refusal naming the data directory", rel, err)
		}
	}
	if _, err := Resolve(root, "ok.txt"); err != nil {
		t.Errorf("an ordinary file is refused: %v", err)
	}

	reg := tools.NewRegistry()
	if err := Register(reg, root); err != nil {
		t.Fatal(err)
	}
	read, _ := reg.Get("read_file")
	for _, path := range []string{"data/api-token", "via-link/api-token"} {
		out, isErr, _ := read.Handle(context.Background(), json.RawMessage(`{"path":"`+path+`"}`))
		if !isErr || strings.Contains(out, secretToken) {
			t.Errorf("read_file %s = %q (error %v)", path, out, isErr)
		}
	}
	write, _ := reg.Get("write_file")
	if out, isErr, _ := write.Handle(context.Background(), json.RawMessage(`{"path":"data/api-token","content":"x"}`)); !isErr {
		t.Errorf("write_file into the data directory succeeded: %s", out)
	}
	// search_files over the folder finds the ordinary file and never enters the data directory.
	if err := os.WriteFile(filepath.Join(data, "other.txt"), []byte("needle "+secretToken+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	sreg := tools.NewRegistry()
	if err := RegisterRoots(sreg, []Root{{Label: "w", Path: root}}, ToolSearchFiles); err != nil {
		t.Fatal(err)
	}
	search, _ := sreg.Get(ToolSearchFiles)
	out, isErr, _ := search.Handle(context.Background(), json.RawMessage(`{"pattern":"needle"}`))
	if isErr || !strings.Contains(out, "ok.txt") || strings.Contains(out, "other.txt") || strings.Contains(out, "api-token") {
		t.Errorf("search_files = %q (error %v)", out, isErr)
	}
}

// What the protection does not cover, stated as a test so a change shows: the
// bash tool is a real shell with the harness's privileges, and the data
// directory is an ordinary directory to it.
func TestBashIsNotConfinedToTheDataDir(t *testing.T) {
	data := t.TempDir()
	if err := os.WriteFile(filepath.Join(data, "api-token"), []byte(secretToken+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	ProtectDir(data)
	workspace := t.TempDir()
	reg := tools.NewRegistry()
	if err := Register(reg, workspace); err != nil {
		t.Fatal(err)
	}
	bash, _ := reg.Get("bash")
	input, _ := json.Marshal(map[string]string{"command": "cat " + filepath.Join(data, "api-token")})
	out, isErr, _ := bash.Handle(context.Background(), input)
	if isErr || !strings.Contains(out, secretToken) {
		t.Fatalf("bash could not read the file (%q, error %v): the residual risk in the docs is out of date", out, isErr)
	}
}
