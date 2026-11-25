// Package apitoken is the bearer token that guards the harness bridge's /v1
// routes. The harness's children (the bash tool, ACP agents, language servers)
// never receive it: the HARNESS_ and *TOKEN* names are outside the child
// environment allow-list (internal/childenv).
package apitoken

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const (
	// EnvVar carries a token chosen by whoever starts the harness.
	EnvVar = "HARNESS_API_TOKEN"
	// EnvDisable (1/true) turns the check off.
	EnvDisable = "HARNESS_NO_API_TOKEN"
	// File is the generated token's file name inside the data directory.
	File = "api-token"
	// MinLength is the shortest token accepted from the environment.
	MinLength = 16
)

// Validate checks a token chosen by the operator: long enough to resist
// guessing and made of printable ASCII, so it fits in a header and a URL.
func Validate(token string) error {
	if len(token) < MinLength {
		return fmt.Errorf("%s must be at least %d characters", EnvVar, MinLength)
	}
	for _, r := range token {
		if r <= ' ' || r > '~' {
			return fmt.Errorf("%s must be printable ASCII without spaces", EnvVar)
		}
	}
	return nil
}

// Generate returns a new random token (256 bits, hex).
func Generate() (string, error) {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

// Path is where Resolve writes a generated token.
func Path(dataDir string) string { return filepath.Join(dataDir, File) }

// Resolve returns the token to enforce. A configured token (HARNESS_API_TOKEN)
// is validated and used as it is; it is not written anywhere. Without one a
// new token is generated and written to {dataDir}/api-token with mode 0600
// (replacing the file of an earlier run). The token is not logged.
func Resolve(dataDir, configured string) (token string, generated bool, err error) {
	if configured != "" {
		if err := Validate(configured); err != nil {
			return "", false, err
		}
		return configured, false, nil
	}
	token, err = Generate()
	if err != nil {
		return "", false, err
	}
	if err := writeFile(dataDir, token); err != nil {
		return "", false, err
	}
	return token, true, nil
}

// writeFile replaces {dir}/api-token with token, readable by the owner only
// from the moment it exists.
func writeFile(dir, token string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".api-token-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer func() { _ = os.Remove(name) }()
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return err
	}
	if _, err := tmp.WriteString(token + "\n"); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(name, Path(dir))
}

// Matcher compares presented tokens with the expected one in constant time.
type Matcher struct{ want [sha256.Size]byte }

// NewMatcher returns a matcher for token, which must not be empty.
func NewMatcher(token string) (*Matcher, error) {
	if token == "" {
		return nil, errors.New("apitoken: empty token")
	}
	return &Matcher{want: sha256.Sum256([]byte(token))}, nil
}

// Match reports whether got is the token. Both sides are hashed first so the
// comparison time does not depend on the length of what was presented.
func (m *Matcher) Match(got string) bool {
	sum := sha256.Sum256([]byte(strings.TrimSpace(got)))
	return subtle.ConstantTimeCompare(sum[:], m.want[:]) == 1
}
