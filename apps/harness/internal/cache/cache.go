package cache

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
)

type Store struct {
	dir string
}

func New(dir string) *Store {
	return &Store{dir: dir}
}

func (s *Store) Get(key string) ([]byte, bool) {
	path, err := s.filePath(key)
	if err != nil {
		return nil, false
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, false
	}
	return data, true
}

func (s *Store) Put(key string, data []byte) error {
	if err := os.MkdirAll(s.dir, 0o755); err != nil {
		return err
	}
	path, err := s.filePath(key)
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func (s *Store) filePath(key string) (string, error) {
	sum := sha256.Sum256([]byte(key))
	name := hex.EncodeToString(sum[:]) + ".json"
	path := filepath.Join(s.dir, name)
	absDir, err := filepath.Abs(s.dir)
	if err != nil {
		return "", err
	}
	absPath, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	if absPath != absDir && !hasPrefix(absPath, absDir+string(filepath.Separator)) {
		return "", fmt.Errorf("cache path escapes dir")
	}
	return absPath, nil
}

func hasPrefix(s, prefix string) bool {
	return len(s) >= len(prefix) && s[:len(prefix)] == prefix
}
