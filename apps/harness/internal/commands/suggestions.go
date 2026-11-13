package commands

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/ndolinschi/Octo/apps/harness/internal/projcfg"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

// Suggestion is a command the project's files suggest. It is only a name and
// the command line that would run it; reading the files never runs anything.
type Suggestion struct {
	// Name is the script, target or recipe name.
	Name    string `json:"name"`
	Command string `json:"command"`
	// Cwd is the label of the folder the file is in.
	Cwd string `json:"cwd"`
	// Source is "package.json", "Makefile" or "justfile".
	Source string `json:"source"`
	// Configured: the project already has a command of this name.
	Configured bool `json:"configured"`
}

const (
	maxSuggestions = 100
	maxFileBytes   = 1 << 20
)

// Suggestions reads the top level of each project folder for package.json
// scripts, Makefile targets and justfile recipes. It never runs a command.
func (s *Service) Suggestions(ctx context.Context, pid string) ([]Suggestion, error) {
	db, err := s.db(ctx, pid)
	if err != nil {
		return nil, err
	}
	folders, err := db.Folders(ctx)
	if err != nil {
		return nil, err
	}
	raw, _, _ := db.Setting(ctx, projectstore.SettingCommands)
	configured := projcfg.ParseCommands(raw)
	out := []Suggestion{}
	for _, f := range folders {
		for _, sg := range suggestFolder(f.Path) {
			sg.Cwd = f.Label
			_, sg.Configured = projcfg.Find(configured, sg.Name)
			if len(out) < maxSuggestions {
				out = append(out, sg)
			}
		}
	}
	return out, nil
}

func readSmall(path string) ([]byte, bool) {
	f, err := os.Open(path)
	if err != nil {
		return nil, false
	}
	defer f.Close()
	if fi, err := f.Stat(); err != nil || !fi.Mode().IsRegular() {
		return nil, false
	}
	b, err := io.ReadAll(io.LimitReader(f, maxFileBytes))
	return b, err == nil
}

func suggestFolder(dir string) []Suggestion {
	var out []Suggestion
	out = append(out, packageScripts(dir)...)
	out = append(out, makeTargets(dir)...)
	out = append(out, justRecipes(dir)...)
	return out
}

// packageRunner is how the folder's package manager runs a script.
func packageRunner(dir, script string) string {
	has := func(n string) bool { _, err := os.Stat(filepath.Join(dir, n)); return err == nil }
	switch {
	case has("pnpm-lock.yaml"):
		return "pnpm run " + script
	case has("yarn.lock"):
		return "yarn " + script
	case has("bun.lockb") || has("bun.lock"):
		return "bun run " + script
	}
	return "npm run " + script
}

var safeName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:@/\-]*$`)

// packageScripts lists the scripts of package.json in file order.
func packageScripts(dir string) []Suggestion {
	b, ok := readSmall(filepath.Join(dir, "package.json"))
	if !ok {
		return nil
	}
	dec := json.NewDecoder(bytes.NewReader(b))
	tok, err := dec.Token()
	if err != nil || tok != json.Delim('{') {
		return nil
	}
	var out []Suggestion
	for dec.More() {
		keyTok, err := dec.Token()
		if err != nil {
			return out
		}
		key, _ := keyTok.(string)
		if key != "scripts" {
			var skip json.RawMessage
			if dec.Decode(&skip) != nil {
				return out
			}
			continue
		}
		if t, err := dec.Token(); err != nil || t != json.Delim('{') {
			return out
		}
		for dec.More() {
			nameTok, err := dec.Token()
			if err != nil {
				return out
			}
			name, _ := nameTok.(string)
			var body json.RawMessage
			if dec.Decode(&body) != nil {
				return out
			}
			// A name with a shell-special character is not offered: it could not be pasted into a command line safely.
			if safeName.MatchString(name) {
				out = append(out, Suggestion{Name: name, Command: packageRunner(dir, name), Source: "package.json"})
			}
		}
		return out
	}
	return out
}

var makeTarget = regexp.MustCompile(`^([A-Za-z0-9][A-Za-z0-9_.\-/]*)\s*:($|[^=])`)

// makeTargets lists the explicit targets of the folder's Makefile (not pattern rules, not special targets).
func makeTargets(dir string) []Suggestion {
	var b []byte
	var ok bool
	for _, n := range []string{"Makefile", "makefile", "GNUmakefile"} {
		if b, ok = readSmall(filepath.Join(dir, n)); ok {
			break
		}
	}
	if !ok {
		return nil
	}
	var out []Suggestion
	seen := map[string]bool{}
	sc := bufio.NewScanner(bytes.NewReader(b))
	sc.Buffer(make([]byte, 0, 64<<10), 1<<20)
	for sc.Scan() {
		line := sc.Text()
		if strings.HasPrefix(line, "\t") || strings.HasPrefix(line, " ") || strings.HasPrefix(line, "#") {
			continue
		}
		m := makeTarget.FindStringSubmatch(line)
		if m == nil || strings.HasPrefix(m[1], ".") || strings.Contains(m[1], "%") || seen[m[1]] {
			continue
		}
		seen[m[1]] = true
		out = append(out, Suggestion{Name: m[1], Command: "make " + m[1], Source: "Makefile"})
	}
	return out
}

var justRecipe = regexp.MustCompile(`^@?([A-Za-z][A-Za-z0-9_\-]*)((?:\s+[^:=\s]+(?:=\S+)?)*)\s*:($|[^=])`)

// justRecipes lists the public recipes of the folder's justfile that need no arguments.
func justRecipes(dir string) []Suggestion {
	var b []byte
	var ok bool
	for _, n := range []string{"justfile", "Justfile", ".justfile"} {
		if b, ok = readSmall(filepath.Join(dir, n)); ok {
			break
		}
	}
	if !ok {
		return nil
	}
	var out []Suggestion
	seen := map[string]bool{}
	sc := bufio.NewScanner(bytes.NewReader(b))
	sc.Buffer(make([]byte, 0, 64<<10), 1<<20)
	for sc.Scan() {
		line := sc.Text()
		if line == "" || strings.HasPrefix(line, " ") || strings.HasPrefix(line, "\t") || strings.HasPrefix(line, "#") ||
			strings.HasPrefix(line, "set ") || strings.HasPrefix(line, "alias ") || strings.HasPrefix(line, "export ") ||
			strings.HasPrefix(line, "import ") || strings.HasPrefix(line, "mod ") {
			continue
		}
		m := justRecipe.FindStringSubmatch(line)
		if m == nil || seen[m[1]] {
			continue
		}
		// A parameter without a default means the recipe cannot run as it is.
		needsArg := false
		for _, p := range strings.Fields(m[2]) {
			if !strings.Contains(p, "=") {
				needsArg = true
			}
		}
		if needsArg {
			continue
		}
		seen[m[1]] = true
		out = append(out, Suggestion{Name: m[1], Command: "just " + m[1], Source: "justfile"})
	}
	return out
}
