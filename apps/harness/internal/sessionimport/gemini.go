package sessionimport

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

type geminiSessionFile struct {
	SessionID   string          `json:"sessionId"`
	ProjectHash string          `json:"projectHash"`
	StartTime   string          `json:"startTime"`
	LastUpdated string          `json:"lastUpdated"`
	Messages    []geminiMessage `json:"messages"`
}

type geminiMessage struct {
	ID        string          `json:"id"`
	Timestamp string          `json:"timestamp"`
	Type      string          `json:"type"`
	Content   json.RawMessage `json:"content"`
	Model     string          `json:"model"`
}

func (s *Scanner) scanGemini(ctx context.Context, keepTurns bool) []Candidate {
	root := filepath.Join(s.homeDir, ".gemini", "tmp")
	projDirs, err := os.ReadDir(root)
	if err != nil {
		return nil
	}
	var out []Candidate
	for _, pd := range projDirs {
		if ctx.Err() != nil || !pd.IsDir() {
			continue
		}
		base := filepath.Join(root, pd.Name())
		cwd := readGeminiProjectRoot(base)
		chatsDir := filepath.Join(base, "chats")
		files, err := os.ReadDir(chatsDir)
		if err != nil {
			continue
		}
		for _, f := range files {
			if ctx.Err() != nil || f.IsDir() {
				continue
			}
			name := f.Name()
			if !strings.HasPrefix(name, "session-") || !strings.HasSuffix(name, ".json") {
				continue
			}
			if c, ok := parseGeminiJSON(filepath.Join(chatsDir, name), cwd, keepTurns); ok {
				out = append(out, c)
			}
		}
	}
	return out
}

func readGeminiProjectRoot(dir string) string {
	for _, name := range []string{".project_root", ".project"} {
		if b, err := os.ReadFile(filepath.Join(dir, name)); err == nil {
			if p := strings.TrimSpace(string(b)); p != "" {
				return p
			}
		}
	}
	return ""
}

func parseGeminiJSON(path, cwd string, keepTurns bool) (Candidate, bool) {
	b, err := os.ReadFile(path)
	if err != nil {
		return Candidate{}, false
	}
	var doc geminiSessionFile
	if json.Unmarshal(b, &doc) != nil {
		return Candidate{}, false
	}
	sessionID := strings.TrimSpace(doc.SessionID)
	if sessionID == "" {
		sessionID = strings.TrimSuffix(filepath.Base(path), ".json")
	}
	var (
		model     string
		turns     []Turn
		startedAt = normalizeTime(doc.StartTime)
		updatedAt = normalizeTime(doc.LastUpdated)
	)
	for _, m := range doc.Messages {
		role := ""
		switch strings.ToLower(m.Type) {
		case "user":
			role = "user"
		case "gemini", "model", "assistant":
			role = "assistant"
		default:
			continue
		}
		if m.Model != "" {
			model = m.Model
		}
		txt := extractGeminiText(m.Content)
		if txt == "" {
			continue
		}
		ts := normalizeTime(m.Timestamp)
		if ts != "" {
			if startedAt == "" || ts < startedAt {
				startedAt = ts
			}
			if updatedAt == "" || ts > updatedAt {
				updatedAt = ts
			}
		}
		turns = append(turns, Turn{Role: role, Text: txt, Timestamp: ts, Model: m.Model})
	}
	turns = collapseTurns(turns)
	ex := countExchanges(turns)
	if len(turns) == 0 || ex == 0 {
		return Candidate{}, false
	}
	fallbackTS := fileModISO(path)
	if startedAt == "" {
		startedAt = fallbackTS
	}
	if updatedAt == "" {
		updatedAt = startedAt
	}
	firstUser := firstUserText(turns)
	c := Candidate{
		Provider:      ProviderGemini,
		ProviderLabel: ProviderLabel(ProviderGemini),
		ID:            sessionID,
		Title:         deriveTitle("", "", firstUser),
		Cwd:           cwd,
		Model:         model,
		StartedAt:     startedAt,
		UpdatedAt:     updatedAt,
		MessageCount:  len(turns),
		ExchangeCount: ex,
		Preview:       clipText(firstUser, 140),
		FilePath:      path,
	}
	if keepTurns {
		c.Turns = turns
	}
	return c, true
}

func extractGeminiText(raw json.RawMessage) string {
	raw = json.RawMessage(strings.TrimSpace(string(raw)))
	if len(raw) == 0 {
		return ""
	}
	if raw[0] == '"' {
		var s string
		if json.Unmarshal(raw, &s) == nil {
			return strings.TrimSpace(s)
		}
		return ""
	}
	if raw[0] == '[' {
		var parts []struct {
			Text string `json:"text"`
		}
		if json.Unmarshal(raw, &parts) != nil {
			return ""
		}
		var out []string
		for _, p := range parts {
			if t := strings.TrimSpace(p.Text); t != "" {
				out = append(out, t)
			}
		}
		return strings.Join(out, "\n\n")
	}
	return ""
}
