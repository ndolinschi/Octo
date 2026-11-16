package sessionimport

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

type codexLine struct {
	Timestamp string          `json:"timestamp"`
	Type      string          `json:"type"`
	Payload   json.RawMessage `json:"payload"`
}

type codexMetaPayload struct {
	ID        string `json:"id"`
	Timestamp string `json:"timestamp"`
	Cwd       string `json:"cwd"`
}

type codexTurnContextPayload struct {
	Cwd   string `json:"cwd"`
	Model string `json:"model"`
}

type codexResponsePayload struct {
	Type    string `json:"type"`
	Role    string `json:"role"`
	Content []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"content"`
}

type codexEventPayload struct {
	Type    string `json:"type"`
	Message string `json:"message"`
}

func (s *Scanner) scanCodex(ctx context.Context, keepTurns bool) []Candidate {
	var files []string
	for _, root := range []string{
		filepath.Join(s.homeDir, ".codex", "sessions"),
		filepath.Join(s.homeDir, ".codex", "archived_sessions"),
	} {
		walkDirIfExists(root, func(path string, d os.DirEntry) error {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if !d.IsDir() && strings.HasSuffix(d.Name(), ".jsonl") {
				files = append(files, path)
			}
			return nil
		})
	}
	var out []Candidate
	for _, f := range files {
		if ctx.Err() != nil {
			break
		}
		if c, ok := parseCodexJSONL(f, keepTurns); ok {
			out = append(out, c)
		}
	}
	return out
}

func parseCodexJSONL(path string, keepTurns bool) (Candidate, bool) {
	stem := strings.TrimSuffix(filepath.Base(path), ".jsonl")
	var (
		sessionID  string
		cwd        string
		model      string
		startedAt  string
		updatedAt  string
		respTurns  []Turn
		eventTurns []Turn
	)
	_ = readLines(path, func(line []byte) error {
		var rec codexLine
		if json.Unmarshal(line, &rec) != nil {
			return nil
		}
		ts := normalizeTime(rec.Timestamp)
		if ts != "" {
			if startedAt == "" || ts < startedAt {
				startedAt = ts
			}
			if updatedAt == "" || ts > updatedAt {
				updatedAt = ts
			}
		}
		switch rec.Type {
		case "session_meta":
			var p codexMetaPayload
			if json.Unmarshal(rec.Payload, &p) == nil {
				if p.ID != "" && sessionID == "" {
					sessionID = p.ID
				}
				if p.Cwd != "" && cwd == "" {
					cwd = p.Cwd
				}
				if mts := normalizeTime(p.Timestamp); mts != "" && (startedAt == "" || mts < startedAt) {
					startedAt = mts
				}
			}
		case "turn_context":
			var p codexTurnContextPayload
			if json.Unmarshal(rec.Payload, &p) == nil {
				if p.Cwd != "" && cwd == "" {
					cwd = p.Cwd
				}
				if p.Model != "" {
					model = p.Model
				}
			}
		case "response_item":
			var p codexResponsePayload
			if json.Unmarshal(rec.Payload, &p) != nil || p.Type != "message" {
				return nil
			}
			if p.Role != "user" && p.Role != "assistant" {
				return nil
			}
			var parts []string
			for _, c := range p.Content {
				switch c.Type {
				case "input_text", "output_text", "text":
					if t := strings.TrimSpace(c.Text); t != "" {
						parts = append(parts, t)
					}
				}
			}
			txt := strings.TrimSpace(strings.Join(parts, "\n\n"))
			if p.Role == "user" {
				txt = stripCodexBoilerplate(txt)
			}
			if txt != "" {
				respTurns = append(respTurns, Turn{Role: p.Role, Text: txt, Timestamp: ts, Model: model})
			}
		case "event_msg":
			var p codexEventPayload
			if json.Unmarshal(rec.Payload, &p) != nil {
				return nil
			}
			switch p.Type {
			case "user_message":
				if txt := stripCodexBoilerplate(p.Message); txt != "" {
					eventTurns = append(eventTurns, Turn{Role: "user", Text: txt, Timestamp: ts})
				}
			case "agent_message":
				if txt := strings.TrimSpace(p.Message); txt != "" {
					eventTurns = append(eventTurns, Turn{Role: "assistant", Text: txt, Timestamp: ts, Model: model})
				}
			}
		}
		return nil
	})
	if sessionID == "" {
		sessionID = stem
	}
	turns := collapseTurns(respTurns)
	if len(turns) == 0 || countExchanges(turns) == 0 {
		turns = collapseTurns(eventTurns)
	}
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
		Provider:      ProviderCodex,
		ProviderLabel: ProviderLabel(ProviderCodex),
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

func stripCodexBoilerplate(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	if strings.HasPrefix(s, "<environment_context>") {
		if idx := strings.Index(s, "</environment_context>"); idx >= 0 {
			s = strings.TrimSpace(s[idx+len("</environment_context>"):])
		} else {
			return ""
		}
	}
	if strings.HasPrefix(s, "# AGENTS.md instructions") {
		if idx := strings.Index(s, "</INSTRUCTIONS>"); idx >= 0 {
			s = strings.TrimSpace(s[idx+len("</INSTRUCTIONS>"):])
		} else {
			return ""
		}
	}
	if strings.HasPrefix(s, "<user_instructions>") {
		if idx := strings.Index(s, "</user_instructions>"); idx >= 0 {
			s = strings.TrimSpace(s[idx+len("</user_instructions>"):])
		} else {
			return ""
		}
	}
	return strings.TrimSpace(s)
}
