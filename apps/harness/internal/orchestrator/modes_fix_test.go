package orchestrator

import (
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/acp"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

func TestSessionModeTargetResumesOutOfPlanOrAsk(t *testing.T) {
	modes := []acp.SessionMode{
		{ID: "plan", Name: "Plan"},
		{ID: "ask", Name: "Ask"},
		{ID: "agent", Name: "Agent"},
	}
	acc := func(a string) func() string { return func() string { return a } }

	if got := sessionModeTarget(false, projectstore.ModeAgent, acc(projectstore.AccessFull), modes, "plan"); got != "agent" {
		t.Fatalf("resumed from plan -> got %q, want %q", got, "agent")
	}
	if got := sessionModeTarget(false, projectstore.ModeAgent, acc(projectstore.AccessFull), modes, "ask"); got != "agent" {
		t.Fatalf("resumed from ask -> got %q, want %q", got, "agent")
	}
	if got := sessionModeTarget(false, projectstore.ModeAgent, acc(projectstore.AccessFull), modes, ""); got != "agent" {
		t.Fatalf("empty base -> got %q, want %q", got, "agent")
	}

	// Still picks plan/ask when readOnly is true.
	if got := sessionModeTarget(true, projectstore.ModePlan, acc(projectstore.AccessFull), modes, "agent"); got != "plan" {
		t.Fatalf("plan turn -> got %q, want %q", got, "plan")
	}

	// Copilot-style URI mode IDs (e.g. ...#agent / ...#plan).
	copilot := []acp.SessionMode{
		{ID: "https://agentclientprotocol.com/protocol/session-modes#plan", Name: "Plan"},
		{ID: "https://agentclientprotocol.com/protocol/session-modes#agent", Name: "Agent mode"},
		{ID: "https://agentclientprotocol.com/protocol/session-modes#autopilot", Name: "Autopilot"},
	}
	wantAgent := "https://agentclientprotocol.com/protocol/session-modes#agent"
	if got := sessionModeTarget(false, projectstore.ModeAgent, acc(projectstore.AccessFull), copilot, copilot[0].ID); got != wantAgent {
		t.Fatalf("copilot resumed from plan -> got %q, want %q", got, wantAgent)
	}

	h := newACPHost(0)
	h.rememberModes("copilot", copilot, wantAgent)
	gotModes, gotBase := h.knownModes("copilot")
	if len(gotModes) != 3 || gotBase != wantAgent {
		t.Fatalf("knownModes = (%d, %q), want (3, %q)", len(gotModes), gotBase, wantAgent)
	}

	// Copilot Autopilot under supervised and accept_edits must drop to Agent (asking mode), not stay in Autopilot.
	autopilot := copilot[2].ID
	if got := sessionModeTarget(false, projectstore.ModeAgent, acc(projectstore.AccessSupervised), copilot, autopilot); got != wantAgent {
		t.Fatalf("copilot autopilot under supervised -> got %q, want %q", got, wantAgent)
	}
	if got := sessionModeTarget(false, projectstore.ModeAgent, acc(projectstore.AccessAcceptEdits), copilot, autopilot); got != wantAgent {
		t.Fatalf("copilot autopilot under accept_edits -> got %q, want %q", got, wantAgent)
	}
	if got := sessionModeTarget(false, projectstore.ModeAgent, acc(projectstore.AccessFull), copilot, autopilot); got != autopilot {
		t.Fatalf("copilot autopilot under full -> got %q, want %q", got, autopilot)
	}
}

func TestInferAgentModeFromReadOnly(t *testing.T) {
	if got := inferAgentModeFromReadOnly("https://agentclientprotocol.com/protocol/session-modes#plan"); got != "https://agentclientprotocol.com/protocol/session-modes#agent" {
		t.Fatalf("URI plan -> got %q", got)
	}
	if got := inferAgentModeFromReadOnly("plan"); got != "default" {
		t.Fatalf("plain plan -> got %q, want default", got)
	}
	if got := inferAgentModeFromReadOnly("ask"); got != "default" {
		t.Fatalf("plain ask -> got %q, want default", got)
	}
	if got := inferAgentModeFromReadOnly("agent"); got != "" {
		t.Fatalf("writable mode -> got %q, want empty", got)
	}
	if got := inferAgentModeFromReadOnly(""); got != "" {
		t.Fatalf("empty mode -> got %q, want empty", got)
	}
}

func TestACPPromptModeNote(t *testing.T) {
	// Fresh Agent turn needs no mode note.
	if got := acpPromptModeNote(projectstore.ModeAgent, "", true); got != "" {
		t.Fatalf("fresh agent turn -> got %q, want empty", got)
	}
	// Consecutive Agent turn needs no mode note.
	if got := acpPromptModeNote(projectstore.ModeAgent, projectstore.ModeAgent, false); got != "" {
		t.Fatalf("consecutive agent turn -> got %q, want empty", got)
	}
	// Switching from Plan or Ask to Agent announces Agent mode.
	if got := acpPromptModeNote(projectstore.ModeAgent, projectstore.ModePlan, false); got != agentModeResumeNote {
		t.Fatalf("plan->agent -> got %q, want resume note", got)
	}
	if got := acpPromptModeNote(projectstore.ModeAgent, projectstore.ModeAsk, false); got != agentModeResumeNote {
		t.Fatalf("ask->agent -> got %q, want resume note", got)
	}
	// Resumed non-fresh session with unknown prior mode announces Agent mode.
	if got := acpPromptModeNote(projectstore.ModeAgent, "", false); got != agentModeResumeNote {
		t.Fatalf("resumed agent turn -> got %q, want resume note", got)
	}
	// Plan and Ask always return their read-only modeNote.
	if got := acpPromptModeNote(projectstore.ModePlan, projectstore.ModeAgent, false); got != modeNote(projectstore.ModePlan) {
		t.Fatalf("agent->plan -> got %q", got)
	}
}

func TestIsCancelledPlanText(t *testing.T) {
	cancelled := []string{
		"Info: Operation cancelled by user",
		"info: operation cancelled by user.",
		"[Info] Operation cancelled by user\n",
		"Operation cancelled by user",
		"Operation canceled by user",
		"Cancelled by user",
		"Request cancelled by user!",
		"Turn cancelled by user",
		"Turn canceled by user.",
	}
	for _, s := range cancelled {
		if !isCancelledPlanText(s) {
			t.Errorf("isCancelledPlanText(%q) = false, want true", s)
		}
	}

	valid := []string{
		"",
		"# Plan: Add fallback\n\n1. Inspect repo",
		"1. Handle cancelled requests cleanly in the worker.",
		"Info: Operation cancelled by user\n\n## Plan\n1. Retry safely",
	}
	for _, s := range valid {
		if isCancelledPlanText(s) {
			t.Errorf("isCancelledPlanText(%q) = true, want false", s)
		}
	}
}
