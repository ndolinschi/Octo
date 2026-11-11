package changes

import (
	"os"
	"path/filepath"
)

func (t *Tracker) shadowPath(hash string) string {
	return filepath.Join(t.shadowDir, hash[:2], hash)
}

// shadowPut keeps a copy of content under its hash; false when the store is
// full (after dropping copies the index no longer needs) or the write failed.
func (t *Tracker) shadowPut(hash string, data []byte) bool {
	if hash == "" {
		return false
	}
	if _, ok := t.shadowHave[hash]; ok {
		return true
	}
	if t.shadowBytes+int64(len(data)) > MaxShadowTotal {
		t.shadowGC()
		if t.shadowBytes+int64(len(data)) > MaxShadowTotal {
			return false
		}
	}
	p := t.shadowPath(hash)
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return false
	}
	if err := os.WriteFile(p, data, 0o600); err != nil {
		return false
	}
	t.shadowHave[hash] = int64(len(data))
	t.shadowBytes += int64(len(data))
	return true
}

func (t *Tracker) shadowGet(hash string) ([]byte, error) { return os.ReadFile(t.shadowPath(hash)) }

// shadowGC removes the copies no index entry refers to.
func (t *Tracker) shadowGC() {
	used := map[string]bool{}
	for _, m := range t.idx {
		for _, e := range m {
			if e.shadow {
				used[e.hash] = true
			}
		}
	}
	for h, n := range t.shadowHave {
		if !used[h] {
			_ = os.Remove(t.shadowPath(h))
			delete(t.shadowHave, h)
			t.shadowBytes -= n
		}
	}
}
