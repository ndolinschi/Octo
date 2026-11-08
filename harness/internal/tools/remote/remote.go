package remote

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"

	"github.com/ndolinschi/Octo/harness/internal/cache"
	"github.com/ndolinschi/Octo/harness/internal/tools"
)

type remoteTool struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"input_schema"`
}

func Register(ctx context.Context, reg *tools.Registry, bases []string, cacheDir string) error {
	c := cache.New(cacheDir)
	client := &http.Client{}
	for _, base := range bases {
		base = strings.TrimRight(base, "/")
		if base == "" {
			continue
		}
		toolsURL := base + "/tools"
		body, err := fetchTools(ctx, client, c, toolsURL)
		if err != nil {
			return fmt.Errorf("%s: %w", toolsURL, err)
		}
		var defs []remoteTool
		if err := json.Unmarshal(body, &defs); err != nil {
			return fmt.Errorf("%s: decode tools: %w", toolsURL, err)
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
			}
			if err := reg.Register(d); err != nil {
				return err
			}
		}
	}
	return nil
}

func fetchTools(ctx context.Context, client *http.Client, c *cache.Store, url string) ([]byte, error) {
	if data, ok := c.Get(url); ok {
		return data, nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("GET tools: status %d", resp.StatusCode)
	}
	if err := c.Put(url, body); err != nil {
		return nil, err
	}
	return body, nil
}

func invokeHandler(client *http.Client, base, name string) tools.Handler {
	invokeURL := base + "/tools/" + name
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
		out, err := io.ReadAll(resp.Body)
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
