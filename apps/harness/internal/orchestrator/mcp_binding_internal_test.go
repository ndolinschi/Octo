package orchestrator

import (
	"context"
	"testing"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/events"
	"github.com/ndolinschi/Octo/apps/harness/internal/mcp"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
	"github.com/ndolinschi/Octo/apps/harness/internal/tools"
)

// Acceptance criterion 11 (spec 2026-11-14, parallel sessions): each main session's ACP process gets its own MCP
// token, bound to that session's root agent; a binding of one session cannot act as the other.
func TestMCPBindingIsPerSession(t *testing.T) {
	store, err := projectstore.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	o := New(store, events.NewHub(), nil, Options{})
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = o.Shutdown(ctx)
	}()
	for _, s := range []struct{ sid, agent string }{{"ses_1", "agt_1"}, {"ses_2", "agt_2"}} {
		os := o.acp.session(skey("prj", s.sid))
		os.mu.Lock()
		os.reg, os.agentID = tools.NewRegistry(), s.agent
		os.mu.Unlock()
	}
	b := mcpBackend{o: o}
	t1 := o.acp.tokens.Issue(mcp.Binding{ProjectID: "prj", SessionID: "ses_1", AgentID: "agt_1"})
	t2 := o.acp.tokens.Issue(mcp.Binding{ProjectID: "prj", SessionID: "ses_2", AgentID: "agt_2"})
	if t1 == t2 || o.LiveMCPTokens() != 2 {
		t.Fatalf("tokens %q %q live %d", t1, t2, o.LiveMCPTokens())
	}
	for tok, want := range map[string]string{t1: "ses_1", t2: "ses_2"} {
		bind, ok := o.acp.tokens.Lookup(tok)
		if !ok || bind.SessionID != want {
			t.Fatalf("token of %s resolves to %+v", want, bind)
		}
		if _, err := b.Tools(bind); err != nil {
			t.Fatalf("own session's tools: %v", err)
		}
	}
	for _, cross := range []mcp.Binding{
		{ProjectID: "prj", SessionID: "ses_1", AgentID: "agt_2"},
		{ProjectID: "prj", SessionID: "ses_2", AgentID: "agt_1"},
		{ProjectID: "prj", SessionID: "ses_3", AgentID: "agt_1"},
	} {
		if _, err := b.Tools(cross); err == nil {
			t.Fatalf("binding %+v reached another session's tools", cross)
		}
		if _, _, err := b.Call(context.Background(), cross, "x", nil); err == nil {
			t.Fatalf("binding %+v called into another session", cross)
		}
	}
}
