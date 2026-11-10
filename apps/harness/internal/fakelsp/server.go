// Package fakelsp is a scripted language server for tests. It speaks LSP base
// framing on stdio and answers a handful of methods deterministically.
package fakelsp

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"

	"github.com/ndolinschi/Octo/apps/harness/internal/lsp"
)

// EnvChild marks a test binary re-executed as the fake server.
const EnvChild = "OCTO_FAKELSP_CHILD"

// ChildMode reports whether this process was started as the fake server.
func ChildMode() bool { return os.Getenv(EnvChild) == "1" }

// Main serves stdin/stdout until EOF or `exit` and returns the exit code.
//
// Behaviour: initialize and shutdown get results; every notification is
// echoed as `fake/echo`; didOpen also yields publishDiagnostics for the
// document. Test hooks: fake/pid (reply with pid), fake/cwd (reply with the working directory), fake/spawn (start a
// sleeping child in the same group, reply with its pid), fake/flood {n}
// (n notifications), fake/big (frame over the size limit), fake/garbage
// (broken header), fake/exit {code}, fake/stderr (write to stderr).
func Main() int {
	in := lsp.NewFrameReader(os.Stdin, lsp.MaxMessageSize)
	for {
		raw, err := in.Read()
		if err == io.EOF {
			return 0
		}
		if err != nil {
			fmt.Fprintln(os.Stderr, "fakelsp:", err)
			return 1
		}
		if code, done := handle(raw); done {
			return code
		}
	}
}

type message struct {
	ID     json.RawMessage `json:"id,omitempty"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params,omitempty"`
}

func send(v any) {
	b, err := json.Marshal(v)
	if err != nil {
		fmt.Fprintln(os.Stderr, "fakelsp:", err)
		return
	}
	if err := lsp.WriteMessage(os.Stdout, b, lsp.MaxMessageSize); err != nil {
		fmt.Fprintln(os.Stderr, "fakelsp:", err)
	}
}

func reply(id json.RawMessage, result any) {
	send(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
}

func notify(method string, params any) {
	send(map[string]any{"jsonrpc": "2.0", "method": method, "params": params})
}

func handle(raw []byte) (code int, done bool) {
	var m message
	if err := json.Unmarshal(raw, &m); err != nil {
		fmt.Fprintln(os.Stderr, "fakelsp: bad json:", err)
		return 1, true
	}
	switch m.Method {
	case "exit":
		return 0, true
	case "fake/exit":
		var p struct{ Code int }
		_ = json.Unmarshal(m.Params, &p)
		return p.Code, true
	case "fake/big":
		fmt.Fprintf(os.Stdout, "Content-Length: %d\r\n\r\n", lsp.MaxMessageSize+1)
	case "fake/garbage":
		fmt.Fprint(os.Stdout, "not a header\r\n\r\n")
	case "fake/flood":
		var p struct{ N int }
		_ = json.Unmarshal(m.Params, &p)
		for i := range p.N {
			notify("fake/flood", map[string]int{"i": i})
		}
	case "fake/stderr":
		fmt.Fprintln(os.Stderr, strings.Repeat("e", 5000))
	case "fake/cwd":
		wd, err := os.Getwd()
		if err != nil {
			fmt.Fprintln(os.Stderr, "fakelsp:", err)
		}
		reply(m.ID, wd)
	case "fake/pid":
		reply(m.ID, os.Getpid())
	case "fake/spawn":
		child := exec.Command("sleep", "300")
		if err := child.Start(); err != nil {
			fmt.Fprintln(os.Stderr, "fakelsp:", err)
			return 1, true
		}
		reply(m.ID, child.Process.Pid)
	case "initialize":
		reply(m.ID, map[string]any{"capabilities": map[string]any{}})
	case "shutdown":
		reply(m.ID, nil)
	default:
		if m.ID != nil {
			reply(m.ID, map[string]any{"method": m.Method})
			return 0, false
		}
		notify("fake/echo", json.RawMessage(raw))
		if m.Method == "textDocument/didOpen" {
			var p struct {
				TextDocument struct{ URI string } `json:"textDocument"`
			}
			_ = json.Unmarshal(m.Params, &p)
			notify("textDocument/publishDiagnostics", map[string]any{
				"uri": p.TextDocument.URI,
				"diagnostics": []map[string]any{{
					"message": "fake diagnostic", "severity": 1,
					"range": map[string]any{"start": map[string]int{"line": 0, "character": 0}, "end": map[string]int{"line": 0, "character": 1}},
				}},
			})
		}
	}
	return 0, false
}
