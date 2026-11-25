package providers

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/usererr"
)

// Reach values of a provider served from a URL (Ollama, the built-in loop on a
// local base URL): "ok" something answered, "not_running" nothing did (state
// not_running), "unchecked" there is no probe (Options.Reach nil).
const (
	ReachOK         = "ok"
	ReachNotRunning = "not_running"
	ReachUnchecked  = "unchecked"
)

// How a reachability result is kept, like the login probe's (providers.md):
// a negative one is probed again after 15 s, a positive one after a minute.
const (
	reachTimeout = 1500 * time.Millisecond
	reachOKFor   = time.Minute
	reachDownFor = 15 * time.Second
)

type reachResult struct {
	ok  bool
	err string
	at  time.Time
}

// HTTPReach is the default probe: an HTTP GET of the URL that any answer
// (whatever the status) counts as reachable. Only a failure to connect, or no
// answer within the timeout, is "not running".
func HTTPReach(ctx context.Context, rawURL string) error {
	ctx, cancel := context.WithTimeout(ctx, reachTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return err
	}
	resp, err := reachClient.Do(req)
	if err != nil {
		var ue *url.Error
		if errors.As(err, &ue) {
			return ue.Err // the cause without `Get "<url>":` (the details already name the URL)
		}
		return err
	}
	_ = resp.Body.Close()
	return nil
}

var reachClient = &http.Client{
	Timeout: reachTimeout,
	// A redirect is an answer: do not follow it anywhere else.
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}

// isLocalURL says whether u points at this computer (localhost or a loopback address).
func isLocalURL(u string) bool {
	p, err := url.Parse(u)
	if err != nil {
		return false
	}
	h := strings.ToLower(p.Hostname())
	if h == "localhost" || strings.HasSuffix(h, ".localhost") {
		return true
	}
	ip := net.ParseIP(h)
	return ip != nil && ip.IsLoopback()
}

// localAPIBase is the built-in loop's base URL when it is on this computer
// (a gateway, LM Studio, the mock model), "" otherwise: the Anthropic API and
// a remote gateway are not probed.
func (s *Service) localAPIBase() string {
	if s.opts.APIBaseURL == nil || s.opts.Reach == nil {
		return ""
	}
	if b := strings.TrimSpace(s.opts.APIBaseURL()); b != "" && isLocalURL(b) {
		return b
	}
	return ""
}

// reachOf is the cached reachability of u. The first look probes at once
// (bounded by reachTimeout); a stale result is probed again in the background
// and providers.updated follows when it changed. Without a probe: unchecked.
func (s *Service) reachOf(u string) (string, reachResult) {
	if s.opts.Reach == nil {
		return ReachUnchecked, reachResult{}
	}
	s.mu.Lock()
	r, seen := s.reach[u]
	s.mu.Unlock()
	if !seen {
		r = s.probeReach(context.Background(), u)
	} else if ttl := reachTTL(r); s.opts.Now().Sub(r.at) >= ttl {
		s.reachLater(u)
	}
	if r.ok {
		return ReachOK, r
	}
	return ReachNotRunning, r
}

func reachTTL(r reachResult) time.Duration {
	if r.ok {
		return reachOKFor
	}
	return reachDownFor
}

// probeReach probes u now, joining a probe of u already running, and keeps the result.
func (s *Service) probeReach(ctx context.Context, u string) reachResult {
	s.mu.Lock()
	if wait, running := s.reaching[u]; running {
		s.mu.Unlock()
		select {
		case <-wait:
		case <-ctx.Done():
		}
		s.mu.Lock()
		r := s.reach[u]
		s.mu.Unlock()
		return r
	}
	done := make(chan struct{})
	s.reaching[u] = done
	s.mu.Unlock()

	err := s.opts.Reach(ctx, u)
	r := reachResult{ok: err == nil, at: s.opts.Now()}
	if err != nil {
		r.err = err.Error()
	}
	s.mu.Lock()
	s.reach[u] = r
	delete(s.reaching, u)
	s.mu.Unlock()
	close(done)
	return r
}

// reachLater re-probes a stale result in the background and refreshes the picture when it changed.
func (s *Service) reachLater(u string) {
	s.mu.Lock()
	if _, running := s.reaching[u]; running {
		s.mu.Unlock()
		return
	}
	before := s.reach[u].ok
	ctx := s.bg
	s.mu.Unlock()
	if ctx == nil {
		ctx = context.Background()
	}
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		if r := s.probeReach(ctx, u); r.ok != before {
			s.Refresh()
		}
	}()
}

// notRunning is the problem of a provider served from u where nothing answered.
func notRunning(label string, u string, r reachResult, startCommand string) *usererr.Error {
	local := isLocalURL(u)
	if !local {
		startCommand = ""
	}
	details := "Nothing answered at " + u
	if r.err != "" {
		details += ": " + r.err
	}
	return usererr.ProviderNotRunning(label, local, startCommand, details+".")
}

// reachURL is the URL whose reachability decides provider id ("" when none is probed).
func (s *Service) reachURL(id string) string {
	switch id {
	case IDOllama:
		if s.opts.Ollama == nil || s.opts.Reach == nil {
			return ""
		}
		return s.ollamaBase()
	case IDAPI:
		return s.localAPIBase()
	}
	return ""
}

// recheckReach probes provider id's URL now ("Check again"); false when the provider has none.
func (s *Service) recheckReach(ctx context.Context, id string) bool {
	u := s.reachURL(id)
	if u == "" {
		return false
	}
	s.probeReach(ctx, u)
	return true
}
