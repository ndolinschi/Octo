package memory_test

import (
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/memory"
)

func TestSettingsAutoMemoryDefaultsValidationAndMerge(t *testing.T) {
	def := memory.ParseSettings("")
	if def.Context != memory.ContextFull || def.RecentExchanges != memory.DefaultRecentExchanges || def.AutoMemory != memory.AutoMemoryOff {
		t.Fatalf("ParseSettings(\"\") = %+v", def)
	}
	for _, valid := range []string{memory.AutoMemoryOff, memory.AutoMemoryAllow, memory.AutoMemoryReview, memory.AutoMemoryBlocked} {
		s := memory.Settings{AutoMemory: valid}
		if err := s.Validate(); err != nil {
			t.Fatalf("Validate(%q) failed: %v", valid, err)
		}
		merged := def.Merge(s)
		if merged.AutoMemory != valid {
			t.Fatalf("Merge(%q) = %+v", valid, merged)
		}
		round := memory.ParseSettings(merged.JSON())
		if round.AutoMemory != valid {
			t.Fatalf("roundtrip %q = %+v", valid, round)
		}
	}
	if err := (memory.Settings{AutoMemory: "unknown"}).Validate(); err == nil {
		t.Fatal("expected error for invalid auto_memory mode")
	}
}
