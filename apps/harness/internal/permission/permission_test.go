package permission

import (
	"context"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/acp"
)

func request(kinds ...acp.OptionKind) Request {
	var r Request
	for i, k := range kinds {
		r.ACP.Options = append(r.ACP.Options, acp.PermissionOption{ID: string(k) + "-id", Name: string(rune('A' + i)), Kind: k})
	}
	return r
}

func TestDefaultPolicyApprovesWithAnAllowOption(t *testing.T) {
	d := Decide(context.Background(), request(acp.RejectOnce, acp.AllowAlways, acp.AllowOnce))
	if !d.Allow || d.OptionID != "allow_once-id" {
		t.Fatalf("decision = %+v, want the allow_once option (preferred over allow_always)", d)
	}
	d = Decide(context.Background(), request(acp.RejectOnce, acp.AllowAlways))
	if !d.Allow || d.OptionID != "allow_always-id" {
		t.Fatalf("decision = %+v", d)
	}
}

func TestDefaultPolicyCancelsWithoutAnAllowOption(t *testing.T) {
	if d := Decide(context.Background(), request(acp.RejectOnce, acp.RejectAlways)); d.Allow || d.OptionID != "" {
		t.Fatalf("decision = %+v, want a cancel", d)
	}
}

type denyAll struct{ seen *Request }

func (p denyAll) Decide(_ context.Context, r Request) Decision {
	*p.seen = r
	return Decision{Reason: "approvals say no"}
}

func TestPolicyCanBeReplaced(t *testing.T) {
	var seen Request
	SetPolicy(denyAll{&seen})
	t.Cleanup(func() { SetPolicy(nil) })
	r := request(acp.AllowOnce)
	r.ProjectID, r.Agent, r.Orchestrator = "prj", "claude-code", true
	if d := Decide(context.Background(), r); d.Allow || d.Reason != "approvals say no" {
		t.Fatalf("decision = %+v", d)
	}
	if seen.ProjectID != "prj" || seen.Agent != "claude-code" || !seen.Orchestrator {
		t.Errorf("the policy saw %+v", seen)
	}
	SetPolicy(nil)
	if d := Decide(context.Background(), request(acp.AllowOnce)); !d.Allow {
		t.Errorf("nil restores the default: %+v", d)
	}
}
