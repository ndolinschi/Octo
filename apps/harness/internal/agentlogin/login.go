package agentlogin

import (
	"sync"

	"github.com/ndolinschi/Octo/apps/harness/internal/terminal"
)

// Login states, as the `login` event and GET /v1/providers carry them.
const (
	StateOK          = "ok"
	StateNotLoggedIn = "not_logged_in"
	StateUnchecked   = "unchecked"
)

// Login is one running login command of an agent: its terminal session and the
// results of the login checks made while it runs.
type Login struct {
	// ID is the terminal session id.
	ID string
	// AgentID is the agent (or account) being logged in.
	AgentID string
	// Command is the terminal command that logs in by hand (the fallback text).
	Command string

	sess *terminal.Session
	done chan struct{}

	mu    sync.Mutex
	state string
	subs  map[chan string]struct{}
}

func newLogin(agentID, command string, sess *terminal.Session) *Login {
	return &Login{ID: sess.ID, AgentID: agentID, Command: command, sess: sess, done: make(chan struct{}), subs: map[chan string]struct{}{}}
}

// Session is the PTY session; its output, input and resize go through it.
func (l *Login) Session() *terminal.Session { return l.sess }

// Done is closed once the process has exited and the last check has been published.
func (l *Login) Done() <-chan struct{} { return l.done }

// State is the latest check result ("" before the first).
func (l *Login) State() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.state
}

// Watch streams the check results. The latest one, if any, is delivered first;
// a slow reader loses older results, never the newest. release detaches it.
func (l *Login) Watch() (<-chan string, func()) {
	ch := make(chan string, 4)
	l.mu.Lock()
	if l.state != "" {
		ch <- l.state
	}
	l.subs[ch] = struct{}{}
	l.mu.Unlock()
	return ch, func() {
		l.mu.Lock()
		delete(l.subs, ch)
		l.mu.Unlock()
	}
}

func (l *Login) publish(state string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.state = state
	for ch := range l.subs {
		for {
			select {
			case ch <- state:
			default:
				select {
				case <-ch:
					continue
				default:
				}
			}
			break
		}
	}
}
