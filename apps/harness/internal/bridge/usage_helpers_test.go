package bridge_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/anthropicclient"
	"github.com/ndolinschi/Octo/apps/harness/internal/bridge"
	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/limits"
	"github.com/ndolinschi/Octo/apps/harness/internal/mockllm"
	"github.com/ndolinschi/Octo/apps/harness/internal/orchestrator"
	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
	"github.com/ndolinschi/Octo/apps/harness/internal/prices"
	"github.com/ndolinschi/Octo/apps/harness/internal/project"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

type usageStack struct {
	*env
	llmHost string
}

// newUsageStack wires the full stack like cmd/harness serve does for usage:
// price table, limits store fed by the client, and the mock model with opts.
func newUsageStack(t *testing.T, priceFile string, reg *plugins.Registry, llmOpts ...mockllm.Option) *usageStack {
	t.Helper()
	return buildUsageStack(t, priceFile, false, orchestrator.Options{}, reg, llmOpts...)
}

// newUsageStackLenient tolerates a malformed price file, as serve does (it logs and goes on).
func newUsageStackLenient(t *testing.T, priceFile string) *usageStack {
	t.Helper()
	return buildUsageStack(t, priceFile, true, orchestrator.Options{}, nil)
}

func buildUsageStack(t *testing.T, priceFile string, lenient bool, oo orchestrator.Options, reg *plugins.Registry, llmOpts ...mockllm.Option) *usageStack {
	t.Helper()
	llmSrv := httptest.NewServer(mockllm.New(0, llmOpts...))
	t.Cleanup(llmSrv.Close)
	u, err := url.Parse(llmSrv.URL)
	if err != nil {
		t.Fatal(err)
	}

	dataDir := t.TempDir()
	if priceFile != "" {
		if err := os.WriteFile(filepath.Join(dataDir, prices.File), []byte(priceFile), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	table, err := prices.Load(filepath.Join(dataDir, prices.File))
	if err != nil && !lenient {
		t.Fatal(err)
	}
	store, err := projectstore.Open(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	lim := limits.NewStore()
	hub := events.NewHub()
	notes := project.NewNotes(store, hub)
	oo.Client = anthropicclient.New("k", llmSrv.URL, "", anthropicclient.WithResponseObserver(lim.Observe))
	oo.MaxTurns, oo.Stream, oo.Agents = 12, true, reg.Agents()
	orch := orchestrator.New(store, hub, notes, oo)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = orch.Shutdown(ctx)
	})
	svc := project.NewService(store, hub, orch, project.Defaults{Models: config.DefaultModels(), MaxDepth: config.DefaultMaxDepth},
		project.WithPrices(table))
	srv := httptest.NewServer(bridge.New(svc, notes, project.NewFiles(store, hub),
		bridge.WithPlugins(reg), bridge.WithLimits(lim)))
	t.Cleanup(srv.Close)
	return &usageStack{env: &env{url: srv.URL}, llmHost: u.Host}
}

// runTurn creates a project (with a folder when dir != "") and waits for one turn.
func (s *usageStack) runTurn(t *testing.T, name, dir, text string) string {
	t.Helper()
	in := map[string]any{"name": name}
	if dir != "" {
		in["folders"] = []map[string]string{{"path": dir}}
	}
	var p struct{ ID string }
	s.into(t, http.MethodPost, "/v1/projects", in, http.StatusCreated, &p)
	s.post(t, p.ID, text)
	return p.ID
}

// post sends a message and waits for the turn to finish.
func (s *usageStack) post(t *testing.T, pid, text string) {
	t.Helper()
	stream := s.subscribe(t, pid)
	s.into(t, http.MethodPost, "/v1/projects/"+pid+"/messages", map[string]string{"text": text}, http.StatusAccepted, nil)
	collectUntilTurnFinished(t, stream)
}
