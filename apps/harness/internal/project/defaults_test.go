package project_test

import (
	"sync"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/project"
)

func TestSetDefaultTiersSwapsDefaultsUnderConcurrency(t *testing.T) {
	m := config.BuiltinModels()
	m.AutoCandidates = []string{"fast", "deep"}
	svc := project.NewService(nil, nil, nil, project.Defaults{Models: m, MaxDepth: 3})

	before := svc.Defaults()
	svc.SetDefaultTiers("acp:claude-code", "f", "b", "d")
	after := svc.Defaults()
	if before.Models.Orchestrator != config.BuiltinModels().Orchestrator {
		t.Fatalf("an earlier copy changed: %+v", before.Models)
	}
	if after.Models.Orchestrator != "acp:claude-code" || after.Models.Fast != "f" || after.Models.Balanced != "b" || after.Models.Deep != "d" ||
		after.MaxDepth != 3 || len(after.Models.AutoCandidates) != 2 {
		t.Fatalf("defaults = %+v", after)
	}
	// The copy is independent of the service's own slice.
	after.Models.AutoCandidates[0] = "changed"
	if svc.Defaults().Models.AutoCandidates[0] != "fast" {
		t.Fatal("Defaults shares its slice")
	}

	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(2)
		go func() {
			defer wg.Done()
			for j := 0; j < 200; j++ {
				svc.SetDefaultTiers("o", "f", "b", "d")
				svc.SetDefaultTiers("o2", "f2", "b2", "d2")
			}
		}()
		go func() {
			defer wg.Done()
			for j := 0; j < 200; j++ {
				d := svc.Defaults().Models
				// A reader sees one write or the other, never a mix.
				if (d.Orchestrator == "o") != (d.Deep == "d") && d.Orchestrator != "acp:claude-code" {
					t.Errorf("torn read: %+v", d)
					return
				}
			}
		}()
	}
	wg.Wait()
}
