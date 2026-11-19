// Package proctree stops a child process together with everything it started,
// and remembers the children of this harness so that a later start can stop
// what a crashed instance left behind.
//
// A terminal shell and a managed process are started as session leaders
// (setsid). A shell's background jobs (`sleep 777 &`) get process groups of
// their own but stay in its session, and they keep that session id after the
// shell exits and they are re-parented to init. KillSession therefore signals
// every process of the session plus every descendant of the leader (a child
// that called setsid itself): SIGHUP, SIGTERM, then SIGKILL after a grace
// period.
//
// Unix only. On Windows (proctree_other.go) the leader alone is killed, as
// before, and nothing is recorded. See apps/harness/docs/architecture.md.
package proctree

import (
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"
)

// DefaultGrace is how long KillSession waits between SIGTERM and SIGKILL.
const DefaultGrace = 2 * time.Second

// LedgerFile is the file in the data folder that lists the running children.
const LedgerFile = "children.json"

// Entry is one recorded child: a session leader and its start time, which
// tells it apart from an unrelated process that later got the same pid.
type Entry struct {
	PID   int    `json:"pid"`
	Start string `json:"start"`
	Kind  string `json:"kind"`
	What  string `json:"what,omitempty"`
}

// Ledger is the list of running children of this harness, written to the data
// folder on every change. A nil *Ledger records nothing.
type Ledger struct {
	path string
	mu   sync.Mutex
	m    map[int]Entry
}

// OpenLedger reads the list a previous instance left (its leftovers) and
// returns a fresh ledger for this instance with them; call Reap before use.
func OpenLedger(dataDir string) *Ledger {
	l := &Ledger{path: filepath.Join(dataDir, LedgerFile), m: map[int]Entry{}}
	b, err := os.ReadFile(l.path)
	if err == nil {
		var list []Entry
		if json.Unmarshal(b, &list) == nil {
			for _, e := range list {
				l.m[e.PID] = e
			}
		}
	}
	return l
}

// Add records a session leader that was just started.
func (l *Ledger) Add(pid int, kind, what string) {
	if l == nil || pid <= 0 {
		return
	}
	start, err := StartTime(pid)
	if err != nil {
		return
	}
	l.mu.Lock()
	l.m[pid] = Entry{PID: pid, Start: start, Kind: kind, What: what}
	l.saveLocked()
	l.mu.Unlock()
}

// Remove forgets a child that has been stopped (or ended by itself).
func (l *Ledger) Remove(pid int) {
	if l == nil {
		return
	}
	l.mu.Lock()
	if _, ok := l.m[pid]; ok {
		delete(l.m, pid)
		l.saveLocked()
	}
	l.mu.Unlock()
}

func (l *Ledger) saveLocked() {
	list := make([]Entry, 0, len(l.m))
	for _, e := range l.m {
		list = append(list, e)
	}
	b, _ := json.Marshal(list)
	tmp := l.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		slog.Warn("record child processes", "err", err)
		return
	}
	_ = os.Rename(tmp, l.path)
}

// Reap stops the sessions a previous instance recorded and did not stop (it
// crashed or was killed): only a pid whose start time still matches the
// record is touched; a reused pid is left alone. It returns what it stopped.
// A terminal's shell cannot be re-adopted (its terminal is gone with the old
// process) and a managed process's output pipes died with it, so leftovers are
// stopped rather than adopted; their runs are marked interrupted elsewhere.
func (l *Ledger) Reap(grace time.Duration) []Entry {
	if l == nil {
		return nil
	}
	l.mu.Lock()
	old := l.m
	l.m = map[int]Entry{}
	l.saveLocked()
	l.mu.Unlock()
	var stopped []Entry
	for _, e := range old {
		start, err := StartTime(e.PID)
		if err != nil || start != e.Start {
			continue // gone, or a different process now has the pid
		}
		KillSession(e.PID, grace)
		stopped = append(stopped, e)
		slog.Warn("stopped a process left running by a previous harness", "pid", e.PID, "kind", e.Kind, "what", e.What)
	}
	return stopped
}

var errNoProcess = errors.New("no such process")

func itoa(n int) string { return strconv.Itoa(n) }
