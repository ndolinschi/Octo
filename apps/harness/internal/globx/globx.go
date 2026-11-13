// Package globx matches slash-separated paths against doublestar glob
// patterns: "*" and "?" stay inside one path segment, "**" as a whole segment
// matches any number of segments (including none), "[abc]" / "[a-z]" / "[!x]"
// match one character, and "{a,b}" alternates (nesting allowed).
package globx

import (
	"path"
	"strings"
)

// Valid reports whether pattern is well formed (balanced braces, valid brackets).
func Valid(pattern string) bool {
	depth := 0
	for i := 0; i < len(pattern); i++ {
		switch pattern[i] {
		case '\\':
			i++
		case '{':
			depth++
		case '}':
			depth--
			if depth < 0 {
				return false
			}
		}
	}
	if depth != 0 {
		return false
	}
	for _, p := range expand(pattern) {
		for _, seg := range strings.Split(p, "/") {
			if _, err := path.Match(seg, ""); err != nil {
				return false
			}
		}
	}
	return true
}

// Match reports whether name (slash separated, no leading slash) matches pattern.
func Match(pattern, name string) bool {
	for _, p := range expand(pattern) {
		if matchSegments(strings.Split(p, "/"), strings.Split(name, "/")) {
			return true
		}
	}
	return false
}

// expand resolves {a,b} alternations into plain patterns (capped).
func expand(p string) []string {
	const maxAlternatives = 64
	open := -1
	depth := 0
	for i := 0; i < len(p); i++ {
		switch p[i] {
		case '\\':
			i++
		case '{':
			if depth == 0 {
				open = i
			}
			depth++
		case '}':
			depth--
			if depth == 0 && open >= 0 {
				var out []string
				for _, alt := range splitTop(p[open+1 : i]) {
					for _, rest := range expand(p[:open] + alt + p[i+1:]) {
						out = append(out, rest)
						if len(out) >= maxAlternatives {
							return out
						}
					}
				}
				return out
			}
		}
	}
	return []string{p}
}

// splitTop splits s at commas that are not inside nested braces.
func splitTop(s string) []string {
	var out []string
	depth, start := 0, 0
	for i := 0; i < len(s); i++ {
		switch s[i] {
		case '\\':
			i++
		case '{':
			depth++
		case '}':
			depth--
		case ',':
			if depth == 0 {
				out = append(out, s[start:i])
				start = i + 1
			}
		}
	}
	return append(out, s[start:])
}

func matchSegments(pat, name []string) bool {
	for len(pat) > 0 {
		if pat[0] == "**" {
			rest := pat[1:]
			if len(rest) == 0 {
				return true
			}
			for i := 0; i <= len(name); i++ {
				if matchSegments(rest, name[i:]) {
					return true
				}
			}
			return false
		}
		if len(name) == 0 {
			return false
		}
		ok, err := path.Match(pat[0], name[0])
		if err != nil || !ok {
			return false
		}
		pat, name = pat[1:], name[1:]
	}
	return len(name) == 0
}
