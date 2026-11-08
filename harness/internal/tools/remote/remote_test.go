package remote

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/ndolinschi/Octo/harness/internal/cache"
	"github.com/ndolinschi/Octo/harness/internal/tools"
)

func TestRemoteRegisterAndInvoke(t *testing.T) {
	var invokeInput string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/tools":
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `[{"name":"echo","description":"remote echo","input_schema":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"]}}]`)
		case r.Method == http.MethodPost && r.URL.Path == "/tools/echo":
			body, _ := io.ReadAll(r.Body)
			invokeInput = string(body)
			w.Header().Set("Content-Type", "application/json")
			var in struct {
				Text string `json:"text"`
			}
			_ = json.Unmarshal(body, &in)
			_, _ = io.WriteString(w, in.Text)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	cacheDir := t.TempDir()
	reg := tools.NewRegistry()
	if err := Register(context.Background(), reg, []string{srv.URL}, cacheDir); err != nil {
		t.Fatalf("Register: %v", err)
	}
	def, ok := reg.Get("echo")
	if !ok {
		t.Fatal("echo not registered")
	}
	if def.Description != "remote echo" {
		t.Fatalf("description %q", def.Description)
	}

	out, isError, err := def.Handle(context.Background(), json.RawMessage(`{"text":"hello"}`))
	if err != nil {
		t.Fatalf("Handle err: %v", err)
	}
	if isError {
		t.Fatalf("isError output=%q", out)
	}
	if out != "hello" {
		t.Fatalf("output %q want hello", out)
	}
	if !strings.Contains(invokeInput, "hello") {
		t.Fatalf("invoke body %q", invokeInput)
	}

	localOut := "local-wins"
	reg2 := tools.NewRegistry()
	_ = reg2.Register(tools.Def{
		Name:        "echo",
		Description: "local echo",
		InputSchema: json.RawMessage(`{"type":"object"}`),
		Handle: func(ctx context.Context, input json.RawMessage) (string, bool, error) {
			return localOut, false, nil
		},
	})
	if err := Register(context.Background(), reg2, []string{srv.URL}, t.TempDir()); err != nil {
		t.Fatalf("Register collision: %v", err)
	}
	def2, ok := reg2.Get("echo")
	if !ok {
		t.Fatal("echo missing after collision register")
	}
	if def2.Description != "local echo" {
		t.Fatalf("expected local shadow, description %q", def2.Description)
	}
	out2, isError, err := def2.Handle(context.Background(), json.RawMessage(`{}`))
	if err != nil {
		t.Fatalf("Handle err: %v", err)
	}
	if isError || out2 != localOut {
		t.Fatalf("expected local handler out=%q isError=%v", out2, isError)
	}
}

func TestRemoteInvokeNon2xx(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && r.URL.Path == "/tools" {
			_, _ = io.WriteString(w, `[{"name":"fail","description":"fails","input_schema":{"type":"object"}}]`)
			return
		}
		http.Error(w, "nope", http.StatusBadRequest)
	}))
	defer srv.Close()

	reg := tools.NewRegistry()
	if err := Register(context.Background(), reg, []string{srv.URL}, t.TempDir()); err != nil {
		t.Fatalf("Register: %v", err)
	}
	def, ok := reg.Get("fail")
	if !ok {
		t.Fatal("fail not registered")
	}
	out, isError, err := def.Handle(context.Background(), json.RawMessage(`{}`))
	if err != nil {
		t.Fatalf("Handle err: %v", err)
	}
	if !isError {
		t.Fatal("expected isError for non-2xx")
	}
	if !strings.Contains(out, "nope") {
		t.Fatalf("output %q want error body", out)
	}
}

func TestRemoteRegisterBadDiscoverNotCached(t *testing.T) {
	var gets int
	good := `[{"name":"ok","description":"ok","input_schema":{"type":"object"}}]`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && r.URL.Path == "/tools" {
			gets++
			if gets == 1 {
				_, _ = io.WriteString(w, `{not valid json`)
				return
			}
			_, _ = io.WriteString(w, good)
			return
		}
		http.NotFound(w, r)
	}))
	defer srv.Close()

	cacheDir := t.TempDir()
	reg := tools.NewRegistry()
	if err := Register(context.Background(), reg, []string{srv.URL}, cacheDir); err == nil {
		t.Fatal("expected error on bad discover JSON")
	}
	if gets != 1 {
		t.Fatalf("gets after failed register = %d want 1", gets)
	}

	reg = tools.NewRegistry()
	if err := Register(context.Background(), reg, []string{srv.URL}, cacheDir); err != nil {
		t.Fatalf("second Register: %v", err)
	}
	if gets != 2 {
		t.Fatalf("gets after success = %d want 2 (cache must not serve bad body)", gets)
	}
	if _, ok := reg.Get("ok"); !ok {
		t.Fatal("ok tool not registered")
	}
}

func TestRemoteInvokePathEscape(t *testing.T) {
	var escapedPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && r.URL.Path == "/tools" {
			_, _ = io.WriteString(w, `[{"name":"a/b","description":"slash name","input_schema":{"type":"object"}}]`)
			return
		}
		escapedPath = r.URL.EscapedPath()
		_, _ = io.WriteString(w, "ok")
	}))
	defer srv.Close()

	reg := tools.NewRegistry()
	if err := Register(context.Background(), reg, []string{srv.URL}, t.TempDir()); err != nil {
		t.Fatalf("Register: %v", err)
	}
	def, ok := reg.Get("a/b")
	if !ok {
		t.Fatal("a/b not registered")
	}
	_, isError, err := def.Handle(context.Background(), json.RawMessage(`{}`))
	if err != nil || isError {
		t.Fatalf("Handle: err=%v isError=%v", err, isError)
	}
	want := "/tools/" + url.PathEscape("a/b")
	if escapedPath != want {
		t.Fatalf("invoke EscapedPath %q want %q", escapedPath, want)
	}
}

func TestFetchToolsPrefersLiveOverCache(t *testing.T) {
	live := `[{"name":"live","description":"live","input_schema":{"type":"object"}}]`
	stale := `[{"name":"stale","description":"stale","input_schema":{"type":"object"}}]`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && r.URL.Path == "/tools" {
			_, _ = io.WriteString(w, live)
			return
		}
		http.NotFound(w, r)
	}))
	defer srv.Close()

	cacheDir := t.TempDir()
	c := cache.New(cacheDir)
	toolsURL := strings.TrimRight(srv.URL, "/") + "/tools"
	if err := c.Put(toolsURL, []byte(stale)); err != nil {
		t.Fatal(err)
	}
	client := &http.Client{}
	body, fromCache, err := fetchTools(context.Background(), client, c, toolsURL)
	if err != nil {
		t.Fatalf("fetchTools: %v", err)
	}
	if fromCache {
		t.Fatal("expected live fetch")
	}
	if string(body) != live {
		t.Fatalf("body %q", body)
	}
}

func init() {
	slog.SetDefault(slog.New(slog.NewTextHandler(io.Discard, nil)))
}
