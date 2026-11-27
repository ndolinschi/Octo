package accounts

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
)

// maxSlug is the longest slug plugins.ValidSlug accepts.
const maxSlug = 32

func checkName(name string) (string, error) {
	name = strings.TrimSpace(name)
	switch n := utf8.RuneCountInString(name); {
	case n == 0:
		return "", fmt.Errorf("%w: the name is empty", ErrInvalid)
	case n > MaxNameLen:
		return "", fmt.Errorf("%w: the name is longer than %d characters", ErrInvalid, MaxNameLen)
	case strings.ContainsFunc(name, func(r rune) bool { return r < ' ' || r == 0x7f }):
		return "", fmt.Errorf("%w: the name contains control characters", ErrInvalid)
	}
	return name, nil
}

// nameTaken reports whether another account of agent (the default one
// included) has name, ignoring case. self is the account being renamed (nil
// for a new one; ID "" is the default account).
func (s *Service) nameTaken(agent, name string, self *Account) bool {
	if self == nil || self.ID != "" {
		def := s.f.DefaultNames[agent]
		if def == "" {
			def = plugins.DefaultAccountName
		}
		if strings.EqualFold(def, name) {
			return true
		}
	}
	return slices.ContainsFunc(s.f.Accounts, func(a Account) bool {
		return a.Agent == agent && (self == nil || a.ID != self.ID) && strings.EqualFold(a.Name, name)
	})
}

// slugOf makes a slug from a name: lower case, every run of other characters
// one dash, at most maxSlug characters; "account" when nothing is left.
func slugOf(name string) string {
	var b strings.Builder
	dash := false
	for _, r := range strings.ToLower(name) {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' {
			b.WriteRune(r)
			dash = false
		} else if !dash && b.Len() > 0 {
			b.WriteByte('-')
			dash = true
		}
	}
	slug := strings.Trim(b.String(), "-")
	if len(slug) > maxSlug {
		slug = strings.TrimRight(slug[:maxSlug], "-")
	}
	if slug == "" {
		slug = "account"
	}
	return slug
}

// maxSlugTries bounds the search for a free slug.
const maxSlugTries = 1000

// newSlug is the name's slug, with "-2", "-3", ... added while it is reserved,
// taken by another account of agent or its folder under {data}/accounts exists.
// A folder that cannot be examined is an error, never a reason to keep looking.
func (s *Service) newSlug(agent, name string) (string, error) {
	base := slugOf(name)
	for n := 1; n <= maxSlugTries; n++ {
		slug := base
		if n > 1 {
			suffix := "-" + strconv.Itoa(n)
			slug = strings.TrimRight(base[:min(len(base), maxSlug-len(suffix))], "-") + suffix
		}
		free, err := s.slugFree(agent, slug)
		if err != nil {
			return "", fmt.Errorf("check the account folder: %w", err)
		}
		if free {
			return slug, nil
		}
	}
	return "", fmt.Errorf("%w: no free folder name for %q", ErrInvalid, name)
}

func (s *Service) slugFree(agent, slug string) (bool, error) {
	if slug == plugins.ReservedSlug || !plugins.ValidSlug(slug) || s.index(agent, slug) >= 0 {
		return false, nil
	}
	_, err := os.Lstat(filepath.Join(s.root, agent, slug))
	switch {
	case err == nil:
		return false, nil
	case errors.Is(err, fs.ErrNotExist):
		return true, nil
	}
	return false, err
}

// userDir checks a folder the user chose: "~/" is expanded; it must be an
// absolute path of an existing folder without "${".
func userDir(dir string) (string, error) {
	dir = strings.TrimSpace(dir)
	if dir == "~" || strings.HasPrefix(dir, "~/") {
		home, err := os.UserHomeDir()
		if err != nil || home == "" {
			return "", fmt.Errorf("%w: the home folder is unknown", ErrInvalid)
		}
		dir = filepath.Join(home, strings.TrimPrefix(dir[1:], "/"))
	}
	switch {
	case strings.Contains(dir, "${"):
		return "", fmt.Errorf("%w: the folder must not contain ${", ErrInvalid)
	case !filepath.IsAbs(dir):
		return "", fmt.Errorf("%w: the folder must be an absolute path", ErrInvalid)
	}
	dir = filepath.Clean(dir)
	fi, err := os.Stat(dir)
	if err != nil || !fi.IsDir() {
		return "", fmt.Errorf("%w: the folder does not exist", ErrInvalid)
	}
	return dir, nil
}
