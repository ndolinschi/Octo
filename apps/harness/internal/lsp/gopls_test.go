package lsp_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/lsp"
)

const goplsSource = `package main

import "fmt"

func main() {
	var x int = "not an int"
	fmt.Println(x)
}
`

type lspMsg struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
	Result json.RawMessage `json:"result"`
	Error  json.RawMessage `json:"error"`
}

type goplsClient struct {
	t  *testing.T
	s  *lsp.Session
	ch <-chan []byte
}

func (c *goplsClient) send(v any) {
	c.t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		c.t.Fatal(err)
	}
	if err := c.s.Send(context.Background(), b); err != nil {
		c.t.Fatalf("send: %v", err)
	}
}

func (c *goplsClient) request(id int, method string, params any) {
	c.send(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params})
}

func (c *goplsClient) notify(method string, params any) {
	c.send(map[string]any{"jsonrpc": "2.0", "method": method, "params": params})
}

// await reads server messages until match accepts one, answering the
// server-to-client requests gopls issues so it never waits on us.
func (c *goplsClient) await(what string, timeout time.Duration, match func(lspMsg) bool) lspMsg {
	c.t.Helper()
	deadline := time.After(timeout)
	for {
		select {
		case raw, ok := <-c.ch:
			if !ok {
				c.t.Fatalf("gopls ended while waiting for %s", what)
			}
			var m lspMsg
			if err := json.Unmarshal(raw, &m); err != nil {
				c.t.Fatalf("bad message %q: %v", raw, err)
			}
			if m.Method != "" && m.ID != nil {
				var result any
				if m.Method == "workspace/configuration" {
					result = []any{}
				}
				c.send(map[string]any{"jsonrpc": "2.0", "id": m.ID, "result": result})
				continue
			}
			if match(m) {
				return m
			}
		case <-deadline:
			c.t.Fatalf("timed out waiting for %s", what)
		}
	}
}

func isResponse(id int) func(lspMsg) bool {
	return func(m lspMsg) bool { return m.Method == "" && string(m.ID) == fmt.Sprint(id) }
}

func TestGoplsDiagnosticsAndHover(t *testing.T) {
	gopls, err := exec.LookPath("gopls")
	if err != nil {
		t.Skip("gopls not installed")
	}
	if _, err := exec.LookPath("go"); err != nil {
		t.Skip("go toolchain not on PATH")
	}
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(dir, "main.go")
	for name, content := range map[string]string{"go.mod": "module example.com/m\n\ngo 1.21\n", "main.go": goplsSource} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	rootURI := (&url.URL{Scheme: "file", Path: dir}).String()
	fileURI := (&url.URL{Scheme: "file", Path: file}).String()

	m := newManager(t, lsp.Options{})
	sess, err := m.Start(context.Background(), "p1", lsp.Spec{Name: "gopls", Command: gopls, Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	ch, release, err := sess.Subscribe()
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	c := &goplsClient{t: t, s: sess, ch: ch}
	const long = 60 * time.Second

	c.request(1, "initialize", map[string]any{
		"processId": nil, "rootUri": rootURI,
		"workspaceFolders": []map[string]string{{"uri": rootURI, "name": "m"}},
		"capabilities": map[string]any{"textDocument": map[string]any{
			"publishDiagnostics": map[string]any{},
			"hover":              map[string]any{"contentFormat": []string{"markdown", "plaintext"}},
		}},
	})
	if init := c.await("initialize result", long, isResponse(1)); init.Error != nil || !strings.Contains(string(init.Result), "capabilities") {
		t.Fatalf("initialize = %s %s", init.Result, init.Error)
	}
	c.notify("initialized", map[string]any{})
	c.notify("textDocument/didOpen", map[string]any{"textDocument": map[string]any{
		"uri": fileURI, "languageId": "go", "version": 1, "text": goplsSource,
	}})

	diag := c.await("diagnostics for main.go", long, func(m lspMsg) bool {
		if m.Method != "textDocument/publishDiagnostics" {
			return false
		}
		var p struct {
			URI         string            `json:"uri"`
			Diagnostics []json.RawMessage `json:"diagnostics"`
		}
		return json.Unmarshal(m.Params, &p) == nil && p.URI == fileURI && len(p.Diagnostics) > 0
	})
	t.Logf("diagnostics: %s", diag.Params)

	line := strings.Count(goplsSource[:strings.Index(goplsSource, "fmt.Println")], "\n")
	char := strings.Index(strings.Split(goplsSource, "\n")[line], "Println") + 2
	var hover lspMsg
	for id := 2; ; id++ {
		c.request(id, "textDocument/hover", map[string]any{
			"textDocument": map[string]string{"uri": fileURI},
			"position":     map[string]int{"line": line, "character": char},
		})
		hover = c.await("hover result", long, isResponse(id))
		if s := string(hover.Result); hover.Error == nil && s != "" && s != "null" {
			break
		}
		if id > 20 {
			t.Fatalf("hover never produced a result: %s %s", hover.Result, hover.Error)
		}
		time.Sleep(500 * time.Millisecond)
	}
	if !strings.Contains(string(hover.Result), "Println") {
		t.Fatalf("hover = %s", hover.Result)
	}

	c.request(100, "shutdown", nil)
	c.await("shutdown result", long, isResponse(100))
	c.notify("exit", nil)
	for range ch {
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	info, err := sess.Exit(ctx)
	if err != nil || info.Code != 0 || info.Reason != "" {
		t.Fatalf("exit = %+v, %v", info, err)
	}
	waitPidGone(t, sess.PID())
}
