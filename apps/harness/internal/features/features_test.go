package features_test

import (
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/features"
)

func TestStoreDefaultsAndEnv(t *testing.T) {
	s := features.NewStore(func(string) (string, bool) { return "", false })
	if !s.Enabled(features.AutoMemory) {
		t.Fatalf("AutoMemory default = false, want true")
	}
	snap := s.Snapshot()
	if !snap[features.AutoMemory] {
		t.Fatalf("Snapshot[%q] = false, want true", features.AutoMemory)
	}
	s.Set(features.AutoMemory, false)
	if s.Enabled(features.AutoMemory) {
		t.Fatalf("AutoMemory after Set(false) = true, want false")
	}

	off := features.NewStore(func(k string) (string, bool) {
		if k == "HARNESS_FEATURE_AUTO_MEMORY" {
			return "0", true
		}
		return "", false
	})
	if off.Enabled(features.AutoMemory) {
		t.Fatalf("AutoMemory with env=0 = true, want false")
	}
}
