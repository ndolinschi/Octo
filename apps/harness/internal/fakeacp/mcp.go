package fakeacp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
)

// mcpEntry is one element of session/new's mcpServers in the ACP wire shape:
// http {type:"http", name, url, headers[]} or stdio {name, command, args[], env[]}.
type mcpEntry struct {
	Type    string `json:"type"`
	Name    string `json:"name"`
	URL     string `json:"url"`
	Headers []struct {
		Name  string `json:"name"`
		Value string `json:"value"`
	} `json:"headers"`
	Command string   `json:"command"`
	Args    []string `json:"args"`
	Env     []struct {
		Name  string `json:"name"`
		Value string `json:"value"`
	} `json:"env"`
}

// checkMCPServers enforces the schema: an http entry only for an agent that
// advertised mcpCapabilities.http, a stdio entry with an absolute command.
// "" means acceptable.
func (a *agent) checkMCPServers(list []mcpEntry) string {
	for _, e := range list {
		switch e.Type {
		case "http":
			if !a.opts.mcpHTTP {
				return "http MCP servers are not supported (mcpCapabilities.http is false)"
			}
			if e.URL == "" || e.Name == "" || e.Headers == nil {
				return "http MCP server needs name, url and headers"
			}
		case "", "stdio":
			if !filepath.IsAbs(e.Command) || e.Name == "" || e.Args == nil || e.Env == nil {
				return "stdio MCP server needs name, an absolute command, args and env"
			}
		default:
			return "unsupported MCP server type " + e.Type
		}
	}
	return ""
}

// mcpClient is a minimal MCP client over either transport.
type mcpClient struct {
	transport string // "http" or "stdio"
	relayPID  int
	call      func(ctx context.Context, method string, params any) (json.RawMessage, error)
	notify    func(ctx context.Context, method string, params any) error
	close     func()
}

func (a *agent) closeMCP() {
	a.mu.Lock()
	c := a.mcpc
	a.mcpc = nil
	a.mu.Unlock()
	if c != nil {
		c.close()
	}
}

// harnessMCP connects (once per session) to the MCP server the client gave:
// the http entry when the agent advertised http, else the stdio entry.
func (a *agent) harnessMCP(ctx context.Context) (*mcpClient, error) {
	a.mu.Lock()
	if a.mcpc != nil {
		c := a.mcpc
		a.mu.Unlock()
		return c, nil
	}
	servers := a.mcpSrvs
	a.mu.Unlock()
	var pick *mcpEntry
	for i, e := range servers {
		if e.Type == "http" && a.opts.mcpHTTP {
			pick = &servers[i]
			break
		}
		if (e.Type == "" || e.Type == "stdio") && pick == nil {
			pick = &servers[i]
		}
	}
	if pick == nil {
		return nil, errors.New("no MCP server was given")
	}
	var c *mcpClient
	var err error
	if pick.Type == "http" {
		c, err = connectHTTP(*pick)
	} else {
		c, err = connectStdio(*pick)
	}
	if err != nil {
		return nil, err
	}
	if _, err := c.call(ctx, "initialize", map[string]any{
		"protocolVersion": "2025-06-18", "capabilities": map[string]any{},
		"clientInfo": map[string]string{"name": "fake-acp", "version": "0.1.0"},
	}); err != nil {
		c.close()
		return nil, fmt.Errorf("mcp initialize: %w", err)
	}
	if err := c.notify(ctx, "notifications/initialized", map[string]any{}); err != nil {
		c.close()
		return nil, fmt.Errorf("mcp initialized: %w", err)
	}
	a.mu.Lock()
	a.mcpc = c
	a.mu.Unlock()
	return c, nil
}

type rpcReply struct {
	Result json.RawMessage `json:"result"`
	Error  *rpcError       `json:"error"`
}

func decodeReply(raw []byte) (json.RawMessage, error) {
	var r rpcReply
	if err := json.Unmarshal(raw, &r); err != nil {
		return nil, fmt.Errorf("bad MCP reply %q: %w", raw, err)
	}
	if r.Error != nil {
		return nil, fmt.Errorf("mcp error %d: %s", r.Error.Code, r.Error.Message)
	}
	return r.Result, nil
}

func connectHTTP(e mcpEntry) (*mcpClient, error) {
	var mu sync.Mutex
	next := 0
	post := func(ctx context.Context, body map[string]any, wantReply bool) (json.RawMessage, error) {
		raw, _ := json.Marshal(body)
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, e.URL, bytes.NewReader(raw))
		if err != nil {
			return nil, err
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json, text/event-stream")
		for _, h := range e.Headers {
			req.Header.Set(h.Name, h.Value)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return nil, err
		}
		defer resp.Body.Close()
		if !wantReply {
			_, _ = io.Copy(io.Discard, resp.Body)
			if resp.StatusCode != http.StatusAccepted {
				return nil, fmt.Errorf("notification answered HTTP %d", resp.StatusCode)
			}
			return nil, nil
		}
		if resp.StatusCode != http.StatusOK {
			b, _ := io.ReadAll(io.LimitReader(resp.Body, 300))
			return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(b)))
		}
		if strings.HasPrefix(resp.Header.Get("Content-Type"), "text/event-stream") {
			sc := bufio.NewScanner(resp.Body)
			sc.Buffer(make([]byte, 0, 64<<10), 16<<20)
			for sc.Scan() {
				if data, ok := strings.CutPrefix(sc.Text(), "data:"); ok {
					return decodeReply([]byte(strings.TrimSpace(data)))
				}
			}
			return nil, errors.New("event stream ended without a reply")
		}
		b, err := io.ReadAll(resp.Body)
		if err != nil {
			return nil, err
		}
		return decodeReply(b)
	}
	return &mcpClient{
		transport: "http",
		call: func(ctx context.Context, method string, params any) (json.RawMessage, error) {
			mu.Lock()
			next++
			id := next
			mu.Unlock()
			return post(ctx, map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params}, true)
		},
		notify: func(ctx context.Context, method string, params any) error {
			_, err := post(ctx, map[string]any{"jsonrpc": "2.0", "method": method, "params": params}, false)
			return err
		},
		close: func() {},
	}, nil
}

func connectStdio(e mcpEntry) (*mcpClient, error) {
	cmd := exec.Command(e.Command, e.Args...)
	cmd.Env = os.Environ()
	for _, kv := range e.Env {
		cmd.Env = append(cmd.Env, kv.Name+"="+kv.Value)
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start MCP server %s: %w", e.Command, err)
	}
	rd := bufio.NewReaderSize(stdout, 1<<20)
	var mu sync.Mutex
	next := 0
	write := func(m map[string]any) error {
		raw, _ := json.Marshal(m)
		_, err := stdin.Write(append(raw, '\n'))
		return err
	}
	return &mcpClient{
		transport: "stdio", relayPID: cmd.Process.Pid,
		call: func(ctx context.Context, method string, params any) (json.RawMessage, error) {
			mu.Lock()
			defer mu.Unlock()
			next++
			id := next
			if err := write(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params}); err != nil {
				return nil, err
			}
			type res struct {
				raw json.RawMessage
				err error
			}
			ch := make(chan res, 1)
			go func() {
				for {
					line, err := rd.ReadBytes('\n')
					if err != nil {
						ch <- res{nil, err}
						return
					}
					var head struct {
						ID json.RawMessage `json:"id"`
					}
					if json.Unmarshal(line, &head) == nil && string(head.ID) == fmt.Sprint(id) {
						raw, err := decodeReply(line)
						ch <- res{raw, err}
						return
					}
				}
			}()
			select {
			case r := <-ch:
				return r.raw, r.err
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		},
		notify: func(_ context.Context, method string, params any) error {
			mu.Lock()
			defer mu.Unlock()
			return write(map[string]any{"jsonrpc": "2.0", "method": method, "params": params})
		},
		close: func() {
			_ = stdin.Close()
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
		},
	}, nil
}

// mcpTool is one entry of tools/list.
type mcpTool struct {
	Name        string `json:"name"`
	InputSchema struct {
		Properties map[string]struct {
			Enum []string `json:"enum"`
		} `json:"properties"`
	} `json:"inputSchema"`
}

func (c *mcpClient) tools(ctx context.Context) ([]mcpTool, error) {
	raw, err := c.call(ctx, "tools/list", map[string]any{})
	if err != nil {
		return nil, err
	}
	var out struct {
		Tools []mcpTool `json:"tools"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	return out.Tools, nil
}

// callTool returns the text of the result and whether it was an error result.
func (c *mcpClient) callTool(ctx context.Context, name string, args map[string]any) (string, bool, error) {
	raw, err := c.call(ctx, "tools/call", map[string]any{"name": name, "arguments": args})
	if err != nil {
		return "", false, err
	}
	var out struct {
		Content []struct{ Text string } `json:"content"`
		IsError bool                    `json:"isError"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return "", false, err
	}
	var b strings.Builder
	for _, c := range out.Content {
		b.WriteString(c.Text)
	}
	return b.String(), out.IsError, nil
}
