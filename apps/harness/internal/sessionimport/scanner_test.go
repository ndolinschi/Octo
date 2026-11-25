package sessionimport

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeTestFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestScannerAllProvidersAndLoad(t *testing.T) {
	home := t.TempDir()
	ctx := context.Background()

	// 1. Claude Code: main session + agent subfile + sidechain session + >64KB line
	bigSuffix := strings.Repeat("x", 90*1024)
	claudeDir := filepath.Join(home, ".claude", "projects", "-tmp-atlas")
	writeTestFile(t, filepath.Join(claudeDir, "sessions-index.json"), `{
  "entries": [
    {"sessionId": "cl-1", "customTitle": "Fix auth flow", "projectPath": "/tmp/atlas", "created": "2026-11-10T10:00:00Z", "modified": "2026-11-10T10:05:00Z"},
    {"sessionId": "cl-side", "summary": "Ignored sidechain", "isSidechain": true}
  ]
}`)
	writeTestFile(t, filepath.Join(claudeDir, "cl-1.jsonl"), strings.Join([]string{
		`{"type":"user","sessionId":"cl-1","cwd":"/tmp/atlas","timestamp":"2026-11-10T10:00:00Z","message":{"role":"user","content":"<command-name>/clear</command-name>"}}`,
		`{"type":"user","sessionId":"cl-1","cwd":"/tmp/atlas","timestamp":"2026-11-10T10:01:00Z","message":{"role":"user","content":"Fix the token refresh bug"}}`,
		`{"type":"assistant","sessionId":"cl-1","timestamp":"2026-11-10T10:02:00Z","message":{"role":"assistant","model":"claude-sonnet-4-6","content":[{"type":"thinking","text":"..."},{"type":"text","text":"I will inspect auth.go first."},{"type":"tool_use","id":"t1","name":"read"}]}}`,
		`{"type":"assistant","sessionId":"cl-1","timestamp":"2026-11-10T10:03:00Z","message":{"role":"assistant","model":"claude-sonnet-4-6","content":[{"type":"text","text":"Updated token expiry. ` + bigSuffix + `"}]}}`,
	}, "\n")+"\n")
	writeTestFile(t, filepath.Join(claudeDir, "agent-123.jsonl"), `{"type":"user","sessionId":"ag-1","timestamp":"2026-11-10T11:00:00Z","message":{"role":"user","content":"subagent"}}`+"\n")
	writeTestFile(t, filepath.Join(claudeDir, "cl-side.jsonl"), `{"type":"user","sessionId":"cl-side","isSidechain":true,"timestamp":"2026-11-10T11:00:00Z","message":{"role":"user","content":"sidechain"}}`+"\n")

	// 2. Codex CLI: response_item with environment boilerplate stripped
	codexFile := filepath.Join(home, ".codex", "sessions", "2026", "11", "11", "rollout-cdx-1.jsonl")
	writeTestFile(t, codexFile, strings.Join([]string{
		`{"timestamp":"2026-11-11T08:00:00Z","type":"session_meta","payload":{"id":"cdx-1","timestamp":"2026-11-11T08:00:00Z","cwd":"/tmp/orbit"}}`,
		`{"timestamp":"2026-11-11T08:00:01Z","type":"turn_context","payload":{"cwd":"/tmp/orbit","model":"gpt-5.3-codex"}}`,
		`{"timestamp":"2026-11-11T08:00:02Z","type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"system prompt"}]}}`,
		`{"timestamp":"2026-11-11T08:00:03Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>\n<cwd>/tmp/orbit</cwd>\n</environment_context>"}]}}`,
		`{"timestamp":"2026-11-11T08:01:00Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Add pagination to users API"}]}}`,
		`{"timestamp":"2026-11-11T08:02:00Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Added cursor pagination."}]}}`,
	}, "\n")+"\n")

	// 3. Gemini CLI
	geminiRoot := filepath.Join(home, ".gemini", "tmp", "projhash")
	writeTestFile(t, filepath.Join(geminiRoot, ".project_root"), "/tmp/gemini-proj\n")
	writeTestFile(t, filepath.Join(geminiRoot, "chats", "session-2026-11-12-abc.json"), `{
  "sessionId": "gem-1",
  "startTime": "2026-11-12T09:00:00Z",
  "lastUpdated": "2026-11-12T09:10:00Z",
  "messages": [
    {"id": "m1", "timestamp": "2026-11-12T09:00:00Z", "type": "user", "content": "Explain the cache layer"},
    {"id": "m2", "timestamp": "2026-11-12T09:05:00Z", "type": "gemini", "content": [{"text": "It uses an LRU map."}], "model": "gemini-2.5-pro"}
  ]
}`)

	// 4. OpenCode
	ocRoot := filepath.Join(home, ".local", "share", "opencode", "storage")
	writeTestFile(t, filepath.Join(ocRoot, "session", "p1", "oc-1.json"), `{"id":"oc-1","directory":"/tmp/oc","title":"Refactor SQLite pool","time":{"created":1763024400000,"updated":1763024700000}}`)
	writeTestFile(t, filepath.Join(ocRoot, "message", "oc-1", "msg_1.json"), `{"id":"msg_1","role":"user","time":{"created":1763024400000}}`)
	writeTestFile(t, filepath.Join(ocRoot, "part", "msg_1", "prt_1.json"), `{"type":"text","text":"Tune connection pool"}`)
	writeTestFile(t, filepath.Join(ocRoot, "message", "oc-1", "msg_2.json"), `{"id":"msg_2","role":"assistant","modelID":"claude-opus-4","time":{"created":1763024500000}}`)
	writeTestFile(t, filepath.Join(ocRoot, "part", "msg_2", "prt_2.json"), `{"type":"text","text":"Set MaxOpenConns to 4."}`)

	sc := NewScanner(home)
	list, err := sc.Scan(ctx)
	if err != nil {
		t.Fatalf("Scan error: %v", err)
	}
	if len(list) != 4 {
		t.Fatalf("expected 4 sessions, got %d: %+v", len(list), list)
	}

	byProvider := map[string]Candidate{}
	for _, c := range list {
		byProvider[c.Provider] = c
		if len(c.Turns) != 0 {
			t.Errorf("Scan should omit Turns, got %d for %s", len(c.Turns), c.ID)
		}
	}

	cl := byProvider[ProviderClaudeCode]
	if cl.Title != "Fix auth flow" || cl.Cwd != "/tmp/atlas" || cl.Model != "claude-sonnet-4-6" || cl.ExchangeCount != 1 || cl.MessageCount != 2 {
		t.Fatalf("unexpected Claude candidate: %+v", cl)
	}
	loadedCl, ok := sc.Load(ctx, ProviderClaudeCode, "cl-1")
	if !ok || len(loadedCl.Turns) != 2 || !strings.Contains(loadedCl.Turns[1].Text, "Updated token expiry.") {
		t.Fatalf("unexpected loaded Claude session: ok=%v %+v", ok, loadedCl)
	}

	cdx := byProvider[ProviderCodex]
	if cdx.Title != "Add pagination to users API" || cdx.Cwd != "/tmp/orbit" || cdx.Model != "gpt-5.3-codex" || cdx.MessageCount != 2 {
		t.Fatalf("unexpected Codex candidate: %+v", cdx)
	}

	gem := byProvider[ProviderGemini]
	if gem.Title != "Explain the cache layer" || gem.Cwd != "/tmp/gemini-proj" || gem.Model != "gemini-2.5-pro" || gem.MessageCount != 2 {
		t.Fatalf("unexpected Gemini candidate: %+v", gem)
	}

	oc := byProvider[ProviderOpenCode]
	if oc.Title != "Refactor SQLite pool" || oc.Cwd != "/tmp/oc" || oc.Model != "claude-opus-4" || oc.MessageCount != 2 {
		t.Fatalf("unexpected OpenCode candidate: %+v", oc)
	}

	// Ensure OpenCode sorts first (2025/2025 vs 2026) -> Wait: 1763024700000 is 2025-11-13, so Gemini 2026-11-12 is newest!
	if list[0].Provider != ProviderGemini {
		t.Fatalf("expected newest session first (Gemini 2026-11-12), got %s (%s)", list[0].Provider, list[0].UpdatedAt)
	}
}
