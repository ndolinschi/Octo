// Package completion is the pure part of inline completion (the editor's ghost
// text): request validation, the never-sent list, the fill-in-the-middle prompt
// and the post-processing of the model's answer. Calling the model, usage and
// the budget stop are the orchestrator's (see Orchestrator.Complete).
package completion

import (
	"fmt"
	"path"
	"strings"
	"unicode/utf8"
)

// Limits of a request (the client cuts on line boundaries before sending).
const (
	MaxPath      = 500
	MaxLanguage  = 40
	MaxPrefix    = 6000 // characters before the cursor
	MaxSuffix    = 2000 // characters after the cursor
	MaxSnippets  = 3
	MaxSnippet   = 1500
	DefaultLines = 8
	MaxLines     = 20
	// MaxFileBytes: a file larger than this is never sent.
	MaxFileBytes = 1 << 20
	// MaxTokens is the completion's output cap.
	MaxTokens = 160
)

// Snippet is context from another open tab or a recent edit.
type Snippet struct {
	Path string `json:"path"`
	Text string `json:"text"`
}

// Request is the body of POST /v1/projects/{id}/complete.
type Request struct {
	// Folder is the label of the project folder Path is relative to (optional:
	// with it the harness can see the file's real size).
	Folder   string `json:"folder"`
	Path     string `json:"path"`
	Language string `json:"language"`
	Prefix   string `json:"prefix"`
	Suffix   string `json:"suffix"`
	MaxLines int    `json:"max_lines"`
	// Snippets are up to three pieces of context from other open tabs.
	Snippets []Snippet `json:"snippets"`
}

// Result is the answer: the insertion, the model that wrote it and the time the
// model call took.
type Result struct {
	Text  string `json:"text"`
	Model string `json:"model"`
	MS    int64  `json:"ms"`
}

// InvalidError is a request the client has to fix.
type InvalidError struct{ Msg string }

func (e *InvalidError) Error() string { return e.Msg }

// Validate checks the limits.
func (r Request) Validate() error {
	bad := func(f string, a ...any) error { return &InvalidError{fmt.Sprintf(f, a...)} }
	switch {
	case strings.TrimSpace(r.Path) == "" || len(r.Path) > MaxPath:
		return bad("path is required (at most %d characters)", MaxPath)
	case len(r.Language) > MaxLanguage:
		return bad("language is too long")
	case utf8.RuneCountInString(r.Prefix) > MaxPrefix:
		return bad("prefix is at most %d characters: cut it on a line boundary", MaxPrefix)
	case utf8.RuneCountInString(r.Suffix) > MaxSuffix:
		return bad("suffix is at most %d characters: cut it on a line boundary", MaxSuffix)
	case r.MaxLines < 0 || r.MaxLines > MaxLines:
		return bad("max_lines must be between 1 and %d", MaxLines)
	case len(r.Snippets) > MaxSnippets:
		return bad("at most %d snippets", MaxSnippets)
	}
	for _, s := range r.Snippets {
		if utf8.RuneCountInString(s.Text) > MaxSnippet {
			return bad("a snippet is at most %d characters", MaxSnippet)
		}
	}
	return nil
}

// Lines is max_lines with its default.
func (r Request) Lines() int {
	if r.MaxLines == 0 {
		return DefaultLines
	}
	return r.MaxLines
}

// NeverSent says why a file's text must not leave the machine for a model: its
// name (`.env*`, `*.pem`, `*.key`, `id_*`, anything under `.git/`), its size or
// the fact that it is binary. "" means it may be sent. size < 0 means unknown.
func NeverSent(p string, size int64, texts ...string) string {
	p = strings.ReplaceAll(p, "\\", "/")
	for _, seg := range strings.Split(p, "/") {
		if seg == ".git" {
			return "inside .git"
		}
	}
	base := strings.ToLower(path.Base(p))
	switch {
	case base == ".env" || strings.HasPrefix(base, ".env."):
		return "an environment file"
	case strings.HasSuffix(base, ".pem"), strings.HasSuffix(base, ".key"):
		return "a key file"
	case strings.HasPrefix(base, "id_"):
		return "an ssh key file"
	}
	if size > MaxFileBytes {
		return "larger than 1 MB"
	}
	for _, t := range texts {
		if strings.ContainsRune(t, 0) {
			return "binary"
		}
	}
	return ""
}

// System is the system prompt of the completion call.
const System = `You complete code at the cursor of a file. You get the file's path and language, the text before the cursor (<prefix>), the text after it (<suffix>) and sometimes snippets from other files. Return ONLY the text to insert at the cursor: no explanation, no markdown fences, no repetition of the prefix or the suffix. Continue the code the way the file already does. If nothing should be inserted, return nothing.`

// UserMessage builds the fill-in-the-middle prompt in tagged blocks.
func UserMessage(r Request) string {
	var b strings.Builder
	for _, s := range r.Snippets {
		fmt.Fprintf(&b, "<snippet path=%q>\n%s\n</snippet>\n", s.Path, s.Text)
	}
	fmt.Fprintf(&b, "<file path=%q language=%q>\n<prefix>%s</prefix><cursor/><suffix>%s</suffix>\n</file>", r.Path, r.Language, r.Prefix, r.Suffix)
	return b.String()
}

// StopSequences are sent unless the cursor is in an empty block: generation
// ends at the first blank line.
func StopSequences(prefix string) []string {
	if StartsBlock(prefix) {
		return nil
	}
	return []string{"\n\n"}
}

// StartsBlock reports whether the cursor is in an empty block: on a line that
// follows (or ends with) an opening bracket or colon, so a multi-line insertion
// is wanted. A blank line after an ordinary statement is not one.
func StartsBlock(prefix string) bool {
	lines := strings.Split(prefix, "\n")
	cur := strings.TrimRight(lines[len(lines)-1], " \t")
	if strings.TrimSpace(cur) != "" {
		return opensBlock(cur)
	}
	for i := len(lines) - 2; i >= 0; i-- {
		if t := strings.TrimRight(lines[i], " \t"); strings.TrimSpace(t) != "" {
			return opensBlock(t)
		}
	}
	return true // an empty file: anything goes
}

func opensBlock(line string) bool {
	for _, suf := range []string{"{", "(", "[", ":", "=>"} {
		if strings.HasSuffix(line, suf) {
			return true
		}
	}
	return false
}

// Clean turns the model's answer into the insertion: fences, an echoed prefix
// tail or suffix head are stripped; the text ends at the first blank line
// unless the cursor starts a block; at most maxLines lines; a result that only
// repeats the next line of the file is dropped. "" means nothing to suggest.
func Clean(raw, prefix, suffix string, maxLines int) string {
	t := strings.ReplaceAll(raw, "\r\n", "\n")
	t = stripFences(t)
	t = trimEchoedPrefix(t, prefix)
	t = trimEchoedSuffix(t, suffix)
	if strings.HasSuffix(prefix, "\n") {
		t = strings.TrimLeft(t, "\n")
	}
	if !StartsBlock(prefix) {
		if i := strings.Index(t, "\n\n"); i >= 0 {
			t = t[:i]
		}
	}
	if maxLines < 1 {
		maxLines = DefaultLines
	}
	if lines := strings.Split(t, "\n"); len(lines) > maxLines {
		t = strings.Join(lines[:maxLines], "\n")
	}
	t = strings.TrimRight(t, " \t\n")
	if strings.TrimSpace(t) == "" || repeatsNextLine(t, suffix) {
		return ""
	}
	return t
}

func stripFences(t string) string {
	s := strings.TrimLeft(t, "\n")
	if !strings.HasPrefix(s, "```") {
		return t
	}
	if i := strings.Index(s, "\n"); i >= 0 {
		s = s[i+1:]
	} else {
		return ""
	}
	if j := strings.LastIndex(s, "```"); j >= 0 {
		s = s[:j]
	}
	return strings.TrimRight(s, "\n")
}

// trimEchoedPrefix removes the longest tail of prefix (at least 4 characters)
// that the answer starts with.
func trimEchoedPrefix(t, prefix string) string {
	for k := min(len(prefix), len(t)); k >= 4; k-- {
		if !utf8.RuneStart(prefix[len(prefix)-k]) {
			continue
		}
		if strings.HasPrefix(t, prefix[len(prefix)-k:]) {
			return t[k:]
		}
	}
	return t
}

// trimEchoedSuffix removes the longest head of suffix that the answer ends with
// (ignoring trailing whitespace): at least 4 characters, or 2 when it spans a
// line break (a closing bracket on its own line).
func trimEchoedSuffix(t, suffix string) string {
	tt := strings.TrimRight(t, " \t\n")
	for k := len(suffix); k >= 2; k-- {
		if k < len(suffix) && !utf8.RuneStart(suffix[k]) {
			continue
		}
		head := strings.TrimRight(suffix[:k], " \t\n")
		if len(head) < 2 || strings.TrimSpace(head) == "" || (len(head) < 4 && !strings.Contains(head, "\n")) {
			continue
		}
		if strings.HasSuffix(tt, head) {
			return tt[:len(tt)-len(head)]
		}
	}
	return t
}

// repeatsNextLine: the suggestion is the line that already follows the cursor.
func repeatsNextLine(t, suffix string) bool {
	next := ""
	for _, l := range strings.Split(suffix, "\n") {
		if strings.TrimSpace(l) != "" {
			next = strings.TrimSpace(l)
			break
		}
	}
	return next != "" && strings.TrimSpace(t) == next
}
