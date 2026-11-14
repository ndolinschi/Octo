// Package datalock keeps one harness process per data directory: an advisory
// OS lock on <data-dir>/harness.lock, taken before the store is opened or any
// recovery runs, held for the life of the process and released by the OS when
// the process ends (so a killed process never leaves a stale lock behind, which
// a pid file would).
package datalock

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// File is the lock file's name inside the data directory.
const File = "harness.lock"

// ErrInUse is returned (wrapped) when another process holds the lock.
var ErrInUse = errors.New("the data directory is in use by another process")

// Lock is a held data-directory lock.
type Lock struct {
	path    string
	release func() error
}

// Acquire takes the lock of dir (created when missing) without waiting:
// ErrInUse when another process (or another Acquire in this one) holds it.
func Acquire(dir string) (*Lock, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	path := filepath.Join(dir, File)
	release, err := lockFile(path)
	if err != nil {
		if errors.Is(err, ErrInUse) {
			return nil, fmt.Errorf("%w: %s", ErrInUse, path)
		}
		return nil, fmt.Errorf("lock %s: %w", path, err)
	}
	return &Lock{path: path, release: release}, nil
}

// Path is the lock file.
func (l *Lock) Path() string { return l.path }

// Release gives the lock up (the file stays; it carries nothing).
func (l *Lock) Release() error {
	if l == nil || l.release == nil {
		return nil
	}
	r := l.release
	l.release = nil
	return r()
}
