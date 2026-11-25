//go:build !unix

package proctree

import (
	"os"
	"time"
)

// Members: no sessions here; the leader alone.
func Members(leader int) []int { return []int{leader} }

// KillSession kills the leader only (Windows: behaviour unchanged).
func KillSession(leader int, _ time.Duration) {
	if p, err := os.FindProcess(leader); err == nil {
		_ = p.Kill()
	}
}

// StartTime is not known here, so nothing is recorded and nothing is reaped.
func StartTime(int) (string, error) { return "", errNoProcess }
