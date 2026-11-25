package approval

import (
	"errors"
	"fmt"
	"net/url"
	"path"
	"strings"

	"github.com/ndolinschi/Octo/apps/harness/internal/globx"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

// RuleSpec is the rule an "allow always" answer would save: the tool and what
// it matches. Match is a command prefix (the first words of the command, as
// the approval shows it; the whole command when Exact), a path glob for file
// tools, or a host glob for web_fetch.
type RuleSpec struct {
	Tool  string `json:"tool"`
	Match string `json:"match"`
	Exact bool   `json:"exact"`
}

// Tool names of approvals (ACP permission requests are "acp:<kind>").
const (
	ToolBash      = "bash"
	ToolWriteFile = "write_file"
	ToolEdit      = "edit"
	ToolWebFetch  = "web_fetch"
	ACPToolPrefix = "acp:"
)

// ErrNoRule: no rule can be saved for this request (a compound shell command,
// a request that names no command or path, ...).
var ErrNoRule = errors.New("no rule can be saved for this request: it is not a single simple command, a path in a project folder, or a host")

// Tokens splits a shell command into words the way a POSIX shell would for a
// simple command. simple is false when the command is anything else: it has a
// control operator (; & | && || and so on), a redirection, a subshell or
// command substitution, a variable expansion, a leading VAR=value assignment,
// a line break outside quotes, or an unterminated quote. A rule never matches
// such a command, so "pnpm test && rm -rf x" is never covered by a rule for
// "pnpm test".
func Tokens(command string) (words []string, simple bool) {
	var cur strings.Builder
	have := false
	flush := func() {
		if have {
			words = append(words, cur.String())
			cur.Reset()
			have = false
		}
	}
	rs := []rune(command)
	for i := 0; i < len(rs); i++ {
		c := rs[i]
		switch {
		case c == '\'':
			j := i + 1
			for j < len(rs) && rs[j] != '\'' {
				j++
			}
			if j >= len(rs) {
				return nil, false
			}
			cur.WriteString(string(rs[i+1 : j]))
			have = true
			i = j
		case c == '"':
			j := i + 1
			for ; j < len(rs) && rs[j] != '"'; j++ {
				switch rs[j] {
				case '$', '`':
					return nil, false
				case '\\':
					if j+1 < len(rs) && strings.ContainsRune("\"\\$`\n", rs[j+1]) {
						if rs[j+1] == '\n' || rs[j+1] == '$' || rs[j+1] == '`' {
							return nil, false
						}
						j++
					}
				}
				cur.WriteRune(rs[j])
			}
			if j >= len(rs) {
				return nil, false
			}
			have = true
			i = j
		case c == '\\':
			if i+1 >= len(rs) || rs[i+1] == '\n' {
				return nil, false
			}
			i++
			cur.WriteRune(rs[i])
			have = true
		case c == ' ' || c == '\t':
			flush()
		case strings.ContainsRune(";&|<>()`$\n\r", c):
			return nil, false
		case c == '#' && !have:
			return nil, false // a comment: not a command this check can reason about
		default:
			cur.WriteRune(c)
			have = true
		}
	}
	flush()
	if len(words) == 0 {
		return nil, false
	}
	if k := strings.IndexByte(words[0], '='); k > 0 && isName(words[0][:k]) {
		return nil, false
	}
	return words, true
}

func isName(s string) bool {
	for i, r := range s {
		if !(r == '_' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || i > 0 && r >= '0' && r <= '9') {
			return false
		}
	}
	return s != ""
}

// neverPrefix are programs that run whatever they are given next: a rule for one
// of them must be the whole command, never a prefix.
var neverPrefix = map[string]bool{
	"bash": true, "sh": true, "zsh": true, "dash": true, "ksh": true, "fish": true, "env": true, "sudo": true, "doas": true,
	"su": true, "xargs": true, "eval": true, "exec": true, "nohup": true, "nice": true, "time": true, "timeout": true,
	"command": true, "builtin": true, "watch": true, "find": true, "ssh": true, "node": true, "python": true, "python3": true,
	"perl": true, "ruby": true, "npx": true, "bunx": true, "php": true, "awk": true,
}

// subcommands are programs whose second word names what to do ("pnpm test"):
// a suggested rule for them is the first two words. For the words in
// runWords the rule is the whole command (they run another program) except
// that run <script> of a package manager is the first three words.
var subcommands = map[string][]string{
	"git": nil, "pnpm": {"exec", "dlx", "x"}, "npm": {"exec", "x"}, "yarn": {"exec", "dlx"}, "bun": {"x"},
	"cargo": {"run"}, "go": {"run"}, "make": nil, "docker": nil, "kubectl": nil, "gh": nil, "just": nil,
	"deno": {"run"}, "dotnet": {"run"}, "mvn": nil, "gradle": nil, "helm": nil, "terraform": nil, "pip": nil, "poetry": nil,
	"uv": {"run"}, "pytest": nil, "tsc": nil, "eslint": nil, "prettier": nil,
}

var scriptRunners = map[string]bool{"npm": true, "pnpm": true, "yarn": true, "bun": true}

func program(first string) string { return path.Base(strings.ReplaceAll(first, "\\", "/")) }

// suggestCommand is the rule suggested for a command.
func suggestCommand(tool, command string) (RuleSpec, bool) {
	words, ok := Tokens(command)
	if !ok {
		return RuleSpec{}, false
	}
	n := len(words) // the whole command, exactly, unless the program has subcommands
	prefix := false
	prog := program(words[0])
	if runs, ok := subcommands[prog]; ok && !neverPrefix[prog] && len(words) >= 2 && !strings.HasPrefix(words[1], "-") {
		switch {
		case contains(runs, words[1]):
			// runs another program: the whole command, exactly
		case words[1] == "run" && scriptRunners[prog]:
			n, prefix = min(3, len(words)), true
		default:
			n, prefix = 2, true
		}
	}
	return RuleSpec{Tool: tool, Match: strings.Join(words[:n], " "), Exact: !prefix}, true
}

func contains(l []string, s string) bool {
	for _, x := range l {
		if x == s {
			return true
		}
	}
	return false
}

func escapeGlob(p string) string {
	var b strings.Builder
	for _, r := range p {
		if strings.ContainsRune(`*?[]{}\`, r) {
			b.WriteByte('\\')
		}
		b.WriteRune(r)
	}
	return b.String()
}

// isCommandTool: the approval's subject is a shell command.
func isCommandTool(tool string, d Detail) bool {
	return tool == ToolBash || (strings.HasPrefix(tool, ACPToolPrefix) && d.Command != "")
}

func isFileTool(tool string, d Detail) bool {
	return tool == ToolWriteFile || tool == ToolEdit || (strings.HasPrefix(tool, ACPToolPrefix) && d.Command == "" && d.Path != "" && d.Folder != "")
}

// Suggest is the rule an "allow always" answer saves by default for the
// request (tool, detail): the command prefix, the exact path, or the host.
func Suggest(tool string, d Detail) (RuleSpec, bool) {
	switch {
	case tool == ToolWebFetch:
		if h := hostOf(d.URL); h != "" {
			return RuleSpec{Tool: tool, Match: h}, true
		}
	case isCommandTool(tool, d):
		return suggestCommand(tool, d.Command)
	case isFileTool(tool, d):
		if d.Path != "" {
			return RuleSpec{Tool: tool, Match: escapeGlob(path.Clean(d.Path))}, true
		}
	}
	return RuleSpec{}, false
}

func hostOf(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	return strings.ToLower(u.Hostname())
}

// Validate checks a client-chosen match against the request it answers and
// returns the rule to save. The match must cover the request itself; for a
// command it is a prefix of the command's words (and the whole command for a
// program that runs whatever follows, such as bash -c).
func Validate(tool string, d Detail, match string) (RuleSpec, error) {
	match = strings.TrimSpace(match)
	if match == "" {
		if s, ok := Suggest(tool, d); ok {
			return s, nil
		}
		return RuleSpec{}, ErrNoRule
	}
	switch {
	case tool == ToolWebFetch:
		h := hostOf(d.URL)
		if h == "" || !globx.Valid(match) || !globx.Match(strings.ToLower(match), h) {
			return RuleSpec{}, fmt.Errorf("%w: %q does not cover host %q", ErrInvalid, match, h)
		}
		return RuleSpec{Tool: tool, Match: strings.ToLower(match)}, nil
	case isCommandTool(tool, d):
		cmd, ok := Tokens(d.Command)
		if !ok {
			return RuleSpec{}, ErrNoRule
		}
		pre, ok := Tokens(match)
		if !ok || len(pre) == 0 || len(pre) > len(cmd) || !samePrefix(cmd, pre) {
			return RuleSpec{}, fmt.Errorf("%w: match must be the first words of the command", ErrInvalid)
		}
		if len(pre) < len(cmd) && neverPrefix[program(cmd[0])] {
			return RuleSpec{}, fmt.Errorf("%w: %s runs whatever follows it, so only the whole command can be allowed", ErrInvalid, program(cmd[0]))
		}
		if s, ok := suggestCommand(tool, d.Command); ok && s.Match == strings.Join(pre, " ") {
			return s, nil // the client sent the suggestion back
		}
		return RuleSpec{Tool: tool, Match: strings.Join(pre, " "), Exact: len(pre) == len(cmd)}, nil
	case isFileTool(tool, d):
		p := path.Clean(d.Path)
		if !globx.Valid(match) || strings.HasPrefix(match, "/") || strings.Contains(match, "..") || !globx.Match(match, p) {
			return RuleSpec{}, fmt.Errorf("%w: match must be a glob inside the folder that covers %q", ErrInvalid, p)
		}
		return RuleSpec{Tool: tool, Match: match}, nil
	}
	return RuleSpec{}, ErrNoRule
}

func samePrefix(cmd, pre []string) bool {
	for i := range pre {
		if cmd[i] != pre[i] {
			return false
		}
	}
	return true
}

// Allows reports whether a saved rule covers the request (tool, detail).
func Allows(r projectstore.ApprovalRule, tool string, d Detail) bool {
	if r.Tool != tool {
		return false
	}
	switch {
	case tool == ToolWebFetch:
		h := hostOf(d.URL)
		return h != "" && globx.Valid(r.Match) && globx.Match(r.Match, h)
	case isCommandTool(tool, d):
		cmd, ok := Tokens(d.Command)
		if !ok {
			return false
		}
		pre, ok := Tokens(r.Match)
		if !ok || len(pre) == 0 || len(pre) > len(cmd) || !samePrefix(cmd, pre) {
			return false
		}
		return !r.Exact || len(pre) == len(cmd)
	case isFileTool(tool, d):
		if d.Path == "" || d.Folder == "" {
			return false
		}
		p := path.Clean(d.Path)
		if p == "." || strings.HasPrefix(p, "../") || strings.HasPrefix(p, "/") {
			return false
		}
		return globx.Valid(r.Match) && globx.Match(r.Match, p)
	}
	return false
}

// AllowedBy returns the first rule that covers the request.
func AllowedBy(rules []projectstore.ApprovalRule, tool string, d Detail) (projectstore.ApprovalRule, bool) {
	for _, r := range rules {
		if Allows(r, tool, d) {
			return r, true
		}
	}
	return projectstore.ApprovalRule{}, false
}
