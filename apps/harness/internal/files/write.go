package files

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"time"
)

const newFileMode fs.FileMode = 0o644

// Write replaces the file at rel with content via a temp file and rename in
// the same directory, keeping an existing file's permissions. The parent
// directory must exist. When expected is non-nil the file must exist with
// exactly that modification time, else ErrChanged.
func Write(root, rel, content string, expected *time.Time) (Info, error) {
	abs, clean, err := resolve(root, rel)
	if err != nil {
		return Info{}, err
	}
	target, mode, err := writeTarget(abs, expected)
	if err != nil {
		return Info{}, err
	}
	dir := filepath.Dir(target)
	if fi, err := os.Stat(dir); err != nil || !fi.IsDir() {
		if err == nil || errors.Is(err, fs.ErrNotExist) {
			return Info{}, ErrNotFound
		}
		return Info{}, err
	}
	if err := replaceFile(dir, target, []byte(content), mode); err != nil {
		return Info{}, err
	}
	fi, err := os.Stat(target)
	if err != nil {
		return Info{}, err
	}
	return Info{Path: clean, Size: fi.Size(), MTime: fi.ModTime()}, nil
}

// writeTarget checks the existing file (if any) against expected and returns
// the path to replace (a symlink inside the root is followed) and its mode.
func writeTarget(abs string, expected *time.Time) (string, fs.FileMode, error) {
	_, err := os.Lstat(abs)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		if expected != nil {
			return "", 0, ErrChanged
		}
		return abs, newFileMode, nil
	case err != nil:
		return "", 0, err
	}
	real, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return "", 0, err
	}
	fi, err := os.Stat(real)
	if err != nil {
		return "", 0, err
	}
	if !fi.Mode().IsRegular() {
		return "", 0, ErrNotFile
	}
	if expected != nil && !fi.ModTime().Equal(*expected) {
		return "", 0, ErrChanged
	}
	return real, fi.Mode().Perm(), nil
}

func replaceFile(dir, target string, data []byte, mode fs.FileMode) (err error) {
	tmp, err := os.CreateTemp(dir, ".octo-write-*")
	if err != nil {
		return err
	}
	defer func() {
		if err != nil {
			_ = tmp.Close()
			_ = os.Remove(tmp.Name())
		}
	}()
	if _, err = tmp.Write(data); err != nil {
		return err
	}
	if err = tmp.Chmod(mode); err != nil {
		return err
	}
	if err = tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), target)
}
