package agentlogin

import (
	"context"
	"log/slog"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
)

// watch checks the agent's login every PollEvery while the command runs (until
// a check says ok), once more when it exits, and stops the command after
// MaxLife. It ends when the process has exited, which MaxLife and the terminal
// manager's shutdown both force; the finished session is closed Linger later
// (an event stream that saw the end closes it sooner), so one whose client went
// away never stays registered.
func (s *Service) watch(l *Login) {
	defer func() {
		close(l.done)
		time.AfterFunc(s.opts.Linger, func() { s.forget(l, "login finished") })
	}()
	exited := make(chan struct{})
	go func() {
		_, _ = l.sess.Exit(context.Background())
		close(exited)
	}()
	tick := time.NewTicker(s.opts.PollEvery)
	defer tick.Stop()
	life := time.NewTimer(s.opts.MaxLife)
	defer life.Stop()
	ticks := tick.C
	shutdown := s.ctx.Done()
	last := ""
	for {
		select {
		case <-exited:
			if last != StateOK {
				s.check(l)
			}
			return
		case <-ticks:
			if last = s.check(l); last == StateOK {
				ticks = nil
			}
		case <-life.C:
			slog.Warn("agent login stopped: it ran too long", "agent", l.AgentID, "session", l.ID)
			l.sess.Close("login timed out")
		case <-shutdown:
			shutdown = nil
			l.sess.Close("harness shutting down")
		}
	}
}

// check rechecks the agent's login and publishes the result.
func (s *Service) check(l *Login) string {
	ctx, cancel := context.WithTimeout(s.ctx, checkTimeout)
	defer cancel()
	a, ok := s.agents.Recheck(ctx, l.AgentID)
	state := stateOf(a, ok)
	l.publish(state)
	return state
}

func stateOf(a plugins.Agent, ok bool) string {
	switch {
	case !ok || !a.Available || a.LoggedIn == nil:
		return StateUnchecked
	case *a.LoggedIn:
		return StateOK
	}
	return StateNotLoggedIn
}

// forget closes l's session and drops l unless a newer login replaced it.
func (s *Service) forget(l *Login, reason string) {
	l.sess.Close(reason)
	s.mu.Lock()
	if s.logins[l.AgentID] == l {
		delete(s.logins, l.AgentID)
	}
	s.mu.Unlock()
}
