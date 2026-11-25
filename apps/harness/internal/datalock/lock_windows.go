//go:build windows

package datalock

import (
	"errors"
	"syscall"
)

// errSharingViolation is ERROR_SHARING_VIOLATION.
const errSharingViolation syscall.Errno = 32

// lockFile opens path with no sharing allowed: a second open fails with a
// sharing violation until this handle is closed, which Windows does when the
// process ends.
func lockFile(path string) (func() error, error) {
	p, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	h, err := syscall.CreateFile(p, syscall.GENERIC_READ|syscall.GENERIC_WRITE, 0, nil, syscall.OPEN_ALWAYS, syscall.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		if errors.Is(err, errSharingViolation) {
			return nil, ErrInUse
		}
		return nil, err
	}
	return func() error { return syscall.CloseHandle(h) }, nil
}
