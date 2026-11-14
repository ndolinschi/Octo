//go:build unix

package datalock

import (
	"errors"
	"os"
	"syscall"
)

// lockFile holds flock(LOCK_EX) on path through an open descriptor; closing it
// (or the process ending) releases it. flock locks belong to the open file
// description, so a second open in the same process conflicts too.
func lockFile(path string) (func() error, error) {
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = f.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return nil, ErrInUse
		}
		return nil, err
	}
	return f.Close, nil
}
