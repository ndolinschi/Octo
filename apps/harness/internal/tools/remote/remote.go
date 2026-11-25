package remote

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/cache"
	"github.com/ndolinschi/Octo/apps/harness/internal/tools"
)

type remoteTool struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"input_schema"`
}

func Register(ctx context.Context, reg *tools.Registry, bases []string, cacheDir string) error {
	c := cache.New(cacheDir)
	client := &http.Client{Timeout: 30 * time.Second}
	for _, base := range bases {
		base = strings.TrimRight(base, "/")
		if base == "" {
			continue
		}
		toolsURL := base + "/tools"
		body, fromCache, err := fetchTools(ctx, client, c, toolsURL)
		if err != nil {
			return fmt.Errorf("%s: %w", toolsURL, err)
		}
		var defs []remoteTool
		if err := json.Unmarshal(body, &defs); err != nil {
			return fmt.Errorf("%s: decode tools: %w", toolsURL, err)
		}
		if !fromCache {
			if err := c.Put(toolsURL, body); err != nil {
				return err
			}
		}
		for _, rt := range defs {
			if rt.Name == "" {
				continue
			}
			if _, ok := reg.Get(rt.Name); ok {
				slog.Warn("remote tool skipped: name already registered", "name", rt.Name, "base", base)
				continue
			}
			toolBase := base
			toolName := rt.Name
			d := tools.Def{
				Name:        rt.Name,
				Description: rt.Description,
				InputSchema: rt.InputSchema,
				Handle:      invokeHandler(client, toolBase, toolName),
				Server:      serverLabel(base),
			}
			if err := reg.Register(d); err != nil {
				return err
			}
		}
	}
	return nil
}

func fetchTools(ctx context.Context, client *http.Client, c *cache.Store, toolsURL string) ([]byte, bool, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, toolsURL, nil)
	if err != nil {
		return nil, false, err
	}
	resp, err := client.Do(req)
	if err == nil {
		defer resp.Body.Close()
		body, readErr := io.ReadAll(resp.Body)
		if readErr == nil && resp.StatusCode >= 200 && resp.StatusCode < 300 {
			return body, false, nil
		}
		if readErr != nil {
			err = readErr
		} else if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			err = fmt.Errorf("GET tools: status %d", resp.StatusCode)
		}
	}
	if data, ok := c.Get(toolsURL); ok {
		return data, true, nil
	}
	if err != nil {
		return nil, false, err
	}
	return nil, false, fmt.Errorf("GET tools: unreachable")
}

func invokeHandler(client *http.Client, base, name string) tools.Handler {
	invokeURL := base + "/tools/" + url.PathEscape(name)
	return func(ctx context.Context, input json.RawMessage) (string, bool, error) {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, invokeURL, bytes.NewReader(input))
		if err != nil {
			return "", false, err
		}
		req.Header.Set("Content-Type", "application/json")
		resp, err := client.Do(req)
		if err != nil {
			return err.Error(), true, nil
		}
		defer resp.Body.Close()
		limited := io.LimitReader(resp.Body, int64(tools.MaxRemoteBodyBytes)+1)
		out, err := io.ReadAll(limited)
		if err != nil {
			return err.Error(), true, nil
		}
		text := strings.TrimSpace(string(out))
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			if text == "" {
				text = fmt.Sprintf("remote tool %q: status %d", name, resp.StatusCode)
			}
			return text, true, nil
		}
		return text, false, nil
	}
}

// serverLabel is how the context report names a tool server: the host of its
// base URL (the whole string when it does not parse).
func serverLabel(base string) string {
	if u, err := url.Parse(base); err == nil && u.Host != "" {
		return u.Host
	}
	return base
}
