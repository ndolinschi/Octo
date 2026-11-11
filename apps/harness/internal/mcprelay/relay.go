// Package mcprelay is the tiny stdio-to-HTTP bridge behind `harness mcp-relay`:
// an ACP agent that supports only stdio MCP servers starts it, and it forwards
// each newline-delimited JSON-RPC message to the harness's MCP endpoint
// (Streamable HTTP) and writes the answers back. The bearer token comes from
// an environment variable, never from argv.
package mcprelay

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
)

const maxLine = 16 << 20

// Main runs the relay with the arguments after the subcommand and returns the exit code.
func Main(args []string) int {
	fs := flag.NewFlagSet("mcp-relay", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	endpoint := fs.String("url", "", "harness MCP endpoint URL")
	tokenEnv := fs.String("token-env", "", "name of the environment variable holding the bearer token")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := Run(ctx, *endpoint, os.Getenv(*tokenEnv), *tokenEnv, os.Stdin, os.Stdout, os.Stderr); err != nil {
		fmt.Fprintln(os.Stderr, "mcp-relay:", err)
		return 1
	}
	return 0
}

// Run relays until in reaches EOF and every in-flight request has been answered.
func Run(ctx context.Context, endpoint, token, tokenEnv string, in io.Reader, out, errOut io.Writer) error {
	u, err := url.Parse(endpoint)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return fmt.Errorf("--url %q must be an http(s) URL", endpoint)
	}
	if tokenEnv == "" {
		return fmt.Errorf("--token-env is required")
	}
	if token == "" {
		return fmt.Errorf("environment variable %s is empty", tokenEnv)
	}
	r := &relay{endpoint: endpoint, token: token, out: out, errOut: errOut, client: &http.Client{}}
	sc := bufio.NewScanner(in)
	sc.Buffer(make([]byte, 0, 64<<10), maxLine)
	var wg sync.WaitGroup
	for sc.Scan() {
		line := bytes.TrimSpace(sc.Bytes())
		if len(line) == 0 {
			continue
		}
		msg := append([]byte(nil), line...)
		wg.Add(1)
		go func() {
			defer wg.Done()
			r.forward(ctx, msg)
		}()
	}
	wg.Wait()
	return sc.Err()
}

type relay struct {
	endpoint, token string
	client          *http.Client
	wmu             sync.Mutex
	out, errOut     io.Writer
	smu             sync.Mutex
	sessionID       string
}

func (r *relay) forward(ctx context.Context, msg []byte) {
	var head struct {
		ID     json.RawMessage `json:"id"`
		Method string          `json:"method"`
	}
	_ = json.Unmarshal(msg, &head)
	isRequest := head.Method != "" && len(head.ID) > 0

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, r.endpoint, bytes.NewReader(msg))
	if err != nil {
		r.fail(head.ID, isRequest, err.Error())
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("Authorization", "Bearer "+r.token)
	r.smu.Lock()
	if r.sessionID != "" {
		req.Header.Set("Mcp-Session-Id", r.sessionID)
	}
	r.smu.Unlock()
	resp, err := r.client.Do(req)
	if err != nil {
		r.fail(head.ID, isRequest, "harness MCP endpoint unreachable: "+err.Error())
		return
	}
	defer resp.Body.Close()
	if sid := resp.Header.Get("Mcp-Session-Id"); sid != "" {
		r.smu.Lock()
		r.sessionID = sid
		r.smu.Unlock()
	}
	if resp.StatusCode == http.StatusAccepted {
		return
	}
	if resp.StatusCode/100 != 2 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		r.fail(head.ID, isRequest, fmt.Sprintf("harness MCP endpoint answered HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(body))))
		return
	}
	if strings.HasPrefix(resp.Header.Get("Content-Type"), "text/event-stream") {
		r.copySSE(resp.Body)
		return
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxLine))
	if err != nil {
		r.fail(head.ID, isRequest, "reading the harness answer: "+err.Error())
		return
	}
	r.writeJSON(body)
}

func (r *relay) copySSE(body io.Reader) {
	sc := bufio.NewScanner(body)
	sc.Buffer(make([]byte, 0, 64<<10), maxLine)
	var data []string
	flush := func() {
		if len(data) > 0 {
			r.writeJSON([]byte(strings.Join(data, "\n")))
			data = nil
		}
	}
	for sc.Scan() {
		line := sc.Text()
		switch {
		case line == "":
			flush()
		case strings.HasPrefix(line, "data:"):
			data = append(data, strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
		}
	}
	flush()
}

// writeJSON writes one message as a single line (compacted: stdio framing
// forbids embedded newlines).
func (r *relay) writeJSON(b []byte) {
	var buf bytes.Buffer
	if err := json.Compact(&buf, bytes.TrimSpace(b)); err != nil {
		fmt.Fprintln(r.errOut, "mcp-relay: dropping non-JSON answer:", err)
		return
	}
	buf.WriteByte('\n')
	r.wmu.Lock()
	defer r.wmu.Unlock()
	if _, err := r.out.Write(buf.Bytes()); err != nil {
		fmt.Fprintln(r.errOut, "mcp-relay: write:", err)
	}
}

func (r *relay) fail(id json.RawMessage, isRequest bool, msg string) {
	fmt.Fprintln(r.errOut, "mcp-relay:", msg)
	if !isRequest {
		return
	}
	b, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": json.RawMessage(id), "error": map[string]any{"code": -32000, "message": msg}})
	r.writeJSON(b)
}
