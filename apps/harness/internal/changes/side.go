// Package changes records what agents change on disk: explicit writes
// (write_file, ACP fs/write_text_file) and, by before/after snapshots of the
// project folders, whatever a bash command or an ACP agent's own tools did.
package changes

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io/fs"
	"os"
	"slices"
	"unicode/utf8"

	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

// Limits. They are fixed; the docs state them.
const (
	// MaxBlob is the largest file whose content is kept for a diff (the file
	// API's 2 MiB limit); text only.
	MaxBlob = 2 << 20
	// MaxHashBytes is the largest file that is read to be hashed at all.
	MaxHashBytes = 64 << 20
	// MaxShadowFile is the largest file the pre-image store copies.
	MaxShadowFile = 1 << 20
	// MaxShadowTotal bounds the pre-image store of one project.
	MaxShadowTotal = 256 << 20
	// MaxFiles is the most files one folder's snapshot walk visits; the rest
	// is not looked at (changes there are not detected).
	MaxFiles = 20000
)

// Side is one side of a change: the file as it was before or is after.
type Side struct {
	Exists bool
	Size   int64
	// Hash is the sha256 (hex) of the content; "" when it was not hashed.
	Hash string
	// Blob is the content when it is kept for a diff (text within MaxBlob).
	Blob []byte
	// Note says why Blob is nil: a projectstore.Note* value.
	Note string
	// seen is the file's size and mtime as stat'ed before its content was
	// read (ReadSide). The index stores this stamp, never one taken after the
	// read: a write that lands between the read and a later stat would
	// otherwise be indexed as already seen and never recorded.
	seen stamp
}

// text reports whether data may be kept: valid UTF-8 without NUL bytes.
func isText(data []byte) bool { return utf8.Valid(data) && !slices.Contains(data, 0) }

func hashBytes(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// sideOfBytes builds the side for content that is already in memory.
func sideOfBytes(data []byte) Side {
	s := Side{Exists: true, Size: int64(len(data)), Hash: hashBytes(data)}
	switch {
	case !isText(data):
		s.Note = projectstore.NoteBinary
	case len(data) > MaxBlob:
		s.Note = projectstore.NoteTooLarge
	default:
		s.Blob = data
	}
	return s
}

// ReadSide reads the regular file at abs. A missing file is {Exists: false}; a
// file too large to hash is {Exists: true} with no hash.
func ReadSide(abs string) (Side, error) {
	fi, err := os.Lstat(abs)
	if errors.Is(err, fs.ErrNotExist) {
		return Side{}, nil
	}
	if err != nil {
		return Side{}, err
	}
	if !fi.Mode().IsRegular() {
		return Side{}, nil
	}
	if fi.Size() > MaxHashBytes {
		return Side{Exists: true, Size: fi.Size(), Note: projectstore.NoteTooLarge, seen: stampOf(fi)}, nil
	}
	data, err := os.ReadFile(abs)
	if errors.Is(err, fs.ErrNotExist) {
		return Side{}, nil
	}
	if err != nil {
		return Side{}, err
	}
	s := sideOfBytes(data)
	if int64(len(data)) == fi.Size() {
		s.seen = stampOf(fi)
	} // else the file changed between the stat and the read: a zero stamp makes the next snapshot read it again
	return s, nil
}

// HashFile is the sha256 of the file at abs and whether it exists.
func HashFile(abs string) (hash string, exists bool, err error) {
	s, err := ReadSide(abs)
	return s.Hash, s.Exists, err
}
