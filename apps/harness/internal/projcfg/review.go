package projcfg

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"unicode/utf8"
)

// Values of ReviewConfig.Prefer.
const (
	PreferAuto    = "auto"
	PreferSplit   = "split"
	PreferUnified = "unified"
)

// Limits of the review configuration.
const (
	MaxReviewCommands = 20
	MaxGlobs          = 100
	MaxGlobLen        = 200
)

// ReviewConfig is the project's review configuration (UI decision 78, project scope).
type ReviewConfig struct {
	// Commands are the names of project commands to offer on a pull request (the review header's "Run").
	Commands []string `json:"commands"`
	// MechanicalGlobs are extra paths to fold as mechanical in the reading order, on top of the
	// built-in lock file, generated, rename and formatting rules. `*` does not cross `/`, `**`
	// does, a pattern without `/` matches a file name anywhere, a trailing `/` means a directory.
	MechanicalGlobs []string `json:"mechanical_globs"`
	// Prefer is "split" or "unified" diff view, or "auto" (the UI decides by width).
	Prefer string `json:"prefer"`
}

// DefaultReview is what a project without a review configuration has.
func DefaultReview() ReviewConfig {
	return ReviewConfig{Commands: []string{}, MechanicalGlobs: []string{}, Prefer: PreferAuto}
}

// Normalize fills the defaults of an incomplete configuration (nil lists, empty prefer).
func (c ReviewConfig) Normalize() ReviewConfig {
	if c.Commands == nil {
		c.Commands = []string{}
	}
	if c.MechanicalGlobs == nil {
		c.MechanicalGlobs = []string{}
	}
	if c.Prefer == "" {
		c.Prefer = PreferAuto
	}
	return c
}

// ValidateReview checks a configuration (after Normalize) and trims its strings.
func ValidateReview(c *ReviewConfig) error {
	*c = c.Normalize()
	switch c.Prefer {
	case PreferAuto, PreferSplit, PreferUnified:
	default:
		return fmt.Errorf("review.prefer must be %q, %q or %q", PreferSplit, PreferUnified, PreferAuto)
	}
	if len(c.Commands) > MaxReviewCommands {
		return fmt.Errorf("review.commands: at most %d names", MaxReviewCommands)
	}
	seen := map[string]bool{}
	for i, n := range c.Commands {
		n = strings.TrimSpace(n)
		if n == "" || utf8.RuneCountInString(n) > MaxNameRunes || hasControl(n) {
			return fmt.Errorf("review.commands[%d] must be a command name", i)
		}
		if seen[strings.ToLower(n)] {
			return fmt.Errorf("review.commands: %q is listed twice", n)
		}
		seen[strings.ToLower(n)] = true
		c.Commands[i] = n
	}
	if len(c.MechanicalGlobs) > MaxGlobs {
		return fmt.Errorf("review.mechanical_globs: at most %d patterns", MaxGlobs)
	}
	for i, g := range c.MechanicalGlobs {
		g = strings.TrimSpace(g)
		if g == "" || len(g) > MaxGlobLen || hasControl(g) || strings.HasPrefix(g, "!") {
			return fmt.Errorf("review.mechanical_globs[%d] must be a non-empty path pattern (no leading !)", i)
		}
		c.MechanicalGlobs[i] = g
	}
	return nil
}

// ParseReview reads the stored JSON; anything unreadable is the default.
func ParseReview(raw string) ReviewConfig {
	var c ReviewConfig
	if raw == "" || json.Unmarshal([]byte(raw), &c) != nil {
		return DefaultReview()
	}
	if ValidateReview(&c) != nil {
		return DefaultReview()
	}
	return c
}

// MatchAny reports whether path (slash separated, relative) matches any glob.
func MatchAny(globs []string, path string) bool {
	for _, g := range globs {
		if Match(g, path) {
			return true
		}
	}
	return false
}

var globCache = struct {
	sync.Mutex
	m map[string]*regexp.Regexp
}{m: map[string]*regexp.Regexp{}}

// Match reports whether path matches the glob (see ReviewConfig.MechanicalGlobs).
func Match(glob, path string) bool {
	re := compileGlob(glob)
	return re != nil && re.MatchString(path)
}

func compileGlob(glob string) *regexp.Regexp {
	globCache.Lock()
	defer globCache.Unlock()
	if re, ok := globCache.m[glob]; ok {
		return re
	}
	g := strings.TrimPrefix(strings.ReplaceAll(glob, "\\", "/"), "/")
	anywhere := !strings.Contains(strings.TrimSuffix(g, "/"), "/")
	dir := strings.HasSuffix(g, "/")
	g = strings.TrimSuffix(g, "/")
	var b strings.Builder
	b.WriteString("^")
	if anywhere {
		b.WriteString("(?:.*/)?")
	}
	rs := []rune(g)
	for i := 0; i < len(rs); i++ {
		switch c := rs[i]; c {
		case '*':
			if i+1 < len(rs) && rs[i+1] == '*' {
				i++
				if i+1 < len(rs) && rs[i+1] == '/' {
					i++
					b.WriteString("(?:.*/)?")
				} else {
					b.WriteString(".*")
				}
			} else {
				b.WriteString("[^/]*")
			}
		case '?':
			b.WriteString("[^/]")
		default:
			b.WriteString(regexp.QuoteMeta(string(c)))
		}
	}
	if dir {
		b.WriteString("/.*")
	}
	b.WriteString("$")
	re, err := regexp.Compile(b.String())
	if err != nil {
		re = nil
	}
	globCache.m[glob] = re
	return re
}
