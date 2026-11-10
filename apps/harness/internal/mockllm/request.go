package mockllm

import (
	"encoding/json"
	"regexp"
	"strings"
)

type request struct {
	Model    string                  `json:"model"`
	Stream   bool                    `json:"stream"`
	System   json.RawMessage         `json:"system"`
	Tools    []struct{ Name string } `json:"tools"`
	Messages []message               `json:"messages"`
}

type message struct {
	Role    string          `json:"role"`
	Content json.RawMessage `json:"content"`
}

type block struct {
	Type      string          `json:"type"`
	Text      string          `json:"text"`
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Input     json.RawMessage `json:"input"`
	ToolUseID string          `json:"tool_use_id"`
	Content   json.RawMessage `json:"content"`
	IsError   bool            `json:"is_error"`
}

func (m message) blocks() []block {
	var s string
	if json.Unmarshal(m.Content, &s) == nil {
		return []block{{Type: "text", Text: s}}
	}
	var bs []block
	if json.Unmarshal(m.Content, &bs) != nil {
		return nil
	}
	return bs
}

// text joins the text blocks of a message.
func (m message) text() string {
	var b strings.Builder
	for _, bl := range m.blocks() {
		if bl.Type == "text" {
			b.WriteString(bl.Text)
		}
	}
	return b.String()
}

func (b block) resultText() string {
	var s string
	if json.Unmarshal(b.Content, &s) == nil {
		return s
	}
	var parts []block
	if json.Unmarshal(b.Content, &parts) != nil {
		return ""
	}
	var out strings.Builder
	for _, p := range parts {
		out.WriteString(p.Text)
	}
	return out.String()
}

func (r *request) hasTool(name string) bool {
	for _, t := range r.Tools {
		if t.Name == name {
			return true
		}
	}
	return false
}

func (r *request) system() string {
	var s string
	if json.Unmarshal(r.System, &s) == nil {
		return s
	}
	var parts []block
	if json.Unmarshal(r.System, &parts) != nil {
		return ""
	}
	var out strings.Builder
	for _, p := range parts {
		out.WriteString(p.Text)
		out.WriteByte('\n')
	}
	return out.String()
}

var roleLine = regexp.MustCompile(`(?m)^Role: (.+)$`)

func (r *request) role() string {
	if m := roleLine.FindStringSubmatch(r.system()); m != nil {
		return strings.TrimSpace(m[1])
	}
	return "Sub-agent"
}

func (r *request) assistantCountFrom(start int) int {
	n := 0
	for _, m := range r.Messages[start:] {
		if m.Role == "assistant" {
			n++
		}
	}
	return n
}

// lastUserTextIndex finds the latest user message carrying text (not only tool results).
func (r *request) lastUserTextIndex() int {
	for i := len(r.Messages) - 1; i >= 0; i-- {
		if r.Messages[i].Role == "user" && r.Messages[i].text() != "" {
			return i
		}
	}
	return -1
}
