package providers

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"slices"
	"strings"
	"time"

	"github.com/ndolinschi/Octo/apps/harness/internal/acp"
	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
	"github.com/ndolinschi/Octo/apps/harness/internal/usererr"
)

// Discovery turns on model discovery: finding the models of an ACP agent
// without a user request. When an agent becomes ready (its login probe says
// logged in, or it has no probe and its command resolves) and on
// RefreshModels, the harness runs the manifest's models command when there is
// one and, when that gave nothing, starts the agent, opens a throw-away session
// in an empty temporary directory with no MCP servers, reads the models its
// answer lists and closes it. No prompt is sent.
type Discovery struct {
	// InUse reports whether a process of the agent is running for a project; then
	// no discovery process is started, and Live is read instead.
	InUse func(agentID string) bool
	// Live returns the models the agent's live session advertised, when it has one.
	Live func(agentID string) (models []ModelInfo, current string, ok bool)
	// Timeout bounds one discovery (default 20 s).
	Timeout time.Duration
	// MinInterval is the least time between two automatic discoveries of one
	// agent, failures included (default one hour). RefreshModels ignores it.
	MinInterval time.Duration
}

const (
	defaultDiscoveryTimeout = 20 * time.Second
	defaultDiscoveryEvery   = time.Hour
)

func (d *Discovery) timeout() time.Duration {
	if d.Timeout > 0 {
		return d.Timeout
	}
	return defaultDiscoveryTimeout
}

func (d *Discovery) every() time.Duration {
	if d.MinInterval > 0 {
		return d.MinInterval
	}
	return defaultDiscoveryEvery
}

// Errors of RefreshModels and SetCustomModels.
var (
	// ErrUnknownAgent: no ACP agent has that id.
	ErrUnknownAgent = errors.New("unknown agent")
	// ErrDiscoveryOff: model discovery is switched off in this process.
	ErrDiscoveryOff = errors.New("model discovery is off")
)

// NotReadyError says the agent cannot be asked for its models now.
type NotReadyError struct {
	Reason  string
	Problem *usererr.Error
}

func (e *NotReadyError) Error() string { return e.Reason }

// ValidationError is a rejected custom model name.
type ValidationError struct{ Message string }

func (e *ValidationError) Error() string { return e.Message }

// readyToDiscover: the agent's command resolves and nothing says it is logged
// out (its probe answered, or it has none).
func readyToDiscover(a plugins.Agent) bool {
	if !a.Available || (a.LoggedIn != nil && !*a.LoggedIn) {
		return false
	}
	// With a probe, wait for its first answer (yes, or "could not tell").
	return a.ProbeCommand == "" || a.LoggedIn != nil || a.ProbeDone
}

func (s *Service) agent(id string) (plugins.Agent, bool) {
	if s.opts.Agents == nil {
		return plugins.Agent{}, false
	}
	for _, a := range s.opts.Agents() {
		if a.ID == id {
			return a, true
		}
	}
	return plugins.Agent{}, false
}

// Provider is one entry of the current picture.
func (s *Service) Provider(id string) (Provider, bool) {
	for _, p := range s.Snapshot().Providers {
		if p.ID == id {
			return p, true
		}
	}
	return Provider{}, false
}

// recently reports whether the agent's models were looked for within the
// minimum interval.
func (s *Service) recently(id string) bool {
	at, err := time.Parse(time.RFC3339, s.cache.get(id).RefreshedAt)
	return err == nil && s.opts.Now().Sub(at) < s.opts.Discovery.every()
}

// kickDiscovery starts a background discovery for every ready agent that has
// not had one lately. Cheap when there is nothing to do.
func (s *Service) kickDiscovery() {
	if s.opts.Discovery == nil || s.opts.Agents == nil {
		return
	}
	for _, a := range s.opts.Agents() {
		if !readyToDiscover(a) {
			continue
		}
		// A login that changed (the user just logged in) is worth a fresh look
		// whatever the last attempt was.
		login := loginOf(a)
		s.mu.Lock()
		changed := s.login[a.ID] != "" && s.login[a.ID] != login
		if s.login == nil {
			s.login = map[string]string{}
		}
		s.login[a.ID] = login
		_, running := s.disc[a.ID]
		bg := s.bg
		s.mu.Unlock()
		if s.recently(a.ID) && !changed {
			continue
		}
		if running {
			continue
		}
		if bg == nil {
			bg = context.Background()
		}
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			s.discover(bg, a, changed)
		}()
	}
}

// WaitIdle waits for the background discoveries started so far to finish (for
// shutdown and tests).
func (s *Service) WaitIdle() { s.wg.Wait() }

// loginOf is the login value of an available agent.
func loginOf(a plugins.Agent) string {
	switch {
	case a.LoggedIn == nil:
		return LoginUnchecked
	case *a.LoggedIn:
		return LoginOK
	}
	return LoginNotLoggedIn
}

// SetPrefs stores the user's preferred model and role models of an agent.
// preferred nil leaves the preferred model alone; roles (tier -> model, "" for
// the agent's default) are merged key by key. Model names are checked like
// custom models.
func (s *Service) SetPrefs(id string, preferred *string, roles map[string]string) (Provider, error) {
	if _, ok := s.agent(id); !ok {
		return Provider{}, ErrUnknownAgent
	}
	bad := func(what, m string) error {
		return &ValidationError{Message: fmt.Sprintf(
			"%s %q is not a valid model name: use 1 to %d characters, no spaces or control characters, starting with a letter or digit, or \"\" for the agent's default", what, m, maxCustomLen)}
	}
	if preferred != nil && *preferred != "" && !ValidCustomModel(*preferred) {
		return Provider{}, bad("preferred_model", *preferred)
	}
	for tier, m := range roles {
		switch {
		case !slices.Contains(plugins.RoleTiers(), tier):
			return Provider{}, &ValidationError{Message: fmt.Sprintf("roles: %q must be one of fast, balanced, deep", tier)}
		case m != "" && !ValidCustomModel(m):
			return Provider{}, bad("roles."+tier, m)
		}
	}
	if s.cache.setPrefs(id, preferred, roles) {
		s.Refresh()
	}
	p, _ := s.Provider(id)
	return p, nil
}

// RefreshModels looks for the agent's models now, whatever the last attempt
// was, and returns the provider entry (carrying models_error when it failed).
// A discovery already running is joined, not repeated.
func (s *Service) RefreshModels(ctx context.Context, id string) (Provider, error) {
	a, ok := s.agent(id)
	switch {
	case !ok:
		return Provider{}, ErrUnknownAgent
	case s.opts.Discovery == nil:
		return Provider{}, ErrDiscoveryOff
	case !a.Available:
		reason := a.UnavailableReason
		if reason == "" {
			reason = "not installed"
		}
		p := usererr.AgentNotInstalled(a.Label, a.InstallCmd(), strings.TrimSpace(reason+" "+a.InstallHint))
		return Provider{}, &NotReadyError{Reason: p.Message, Problem: p}
	case a.LoggedIn != nil && !*a.LoggedIn:
		p := usererr.AgentNotLoggedIn(a.Label, a.LoginCmd(), a.Hint)
		return Provider{}, &NotReadyError{Reason: p.Message, Problem: p}
	}
	s.discover(ctx, a, true)
	p, _ := s.Provider(id)
	return p, nil
}

// SetCustomModels replaces the model names the user typed for an agent. Names
// are checked (ValidCustomModel), de-duplicated and capped at MaxCustomModels;
// an empty list removes them all.
func (s *Service) SetCustomModels(id string, names []string) (Provider, error) {
	if _, ok := s.agent(id); !ok {
		return Provider{}, ErrUnknownAgent
	}
	var clean []string
	for _, n := range names {
		switch {
		case !ValidCustomModel(n):
			return Provider{}, &ValidationError{Message: fmt.Sprintf(
				"%q is not a valid model name: use 1 to %d characters, no spaces or control characters, starting with a letter or digit", n, maxCustomLen)}
		case !slices.Contains(clean, n):
			clean = append(clean, n)
		}
	}
	if len(clean) > MaxCustomModels {
		return Provider{}, &ValidationError{Message: fmt.Sprintf("at most %d custom models per agent", MaxCustomModels)}
	}
	if s.cache.setCustom(id, clean) {
		s.Refresh()
	}
	p, _ := s.Provider(id)
	return p, nil
}

// discover runs one discovery of a. force skips the minimum interval and waits
// for a discovery that is already running.
func (s *Service) discover(ctx context.Context, a plugins.Agent, force bool) {
	d := s.opts.Discovery
	s.mu.Lock()
	if ch, running := s.disc[a.ID]; running {
		s.mu.Unlock()
		if force {
			select {
			case <-ch:
			case <-ctx.Done():
			}
		}
		return
	}
	if !force && s.recently(a.ID) {
		s.mu.Unlock()
		return
	}
	if s.disc == nil {
		s.disc = map[string]chan struct{}{}
	}
	done := make(chan struct{})
	s.disc[a.ID] = done
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.disc, a.ID)
		s.mu.Unlock()
		close(done)
	}()

	if d.InUse != nil && d.InUse(a.ID) {
		// A live session of the agent exists: it reports its models itself.
		if d.Live != nil {
			if models, cur, ok := d.Live(a.ID); ok {
				s.RecordModels(a.ID, models, cur)
			}
		}
		return
	}

	rctx, cancel := context.WithTimeout(ctx, d.timeout())
	defer cancel()
	errText := s.runDiscovery(rctx, a)
	if ctx.Err() != nil {
		return // the caller went away: nothing was learned, nothing is recorded
	}
	if rctx.Err() != nil && errText != "" {
		errText = fmt.Sprintf("timed out after %s", d.timeout())
	}
	if errText != "" {
		slog.Info("agent model discovery failed", "agent", a.ID, "err", errText)
	}
	s.cache.markRefresh(a.ID, s.opts.Now(), errText)
	s.Refresh()
}

// runDiscovery tries the models command, then the session; it returns a short
// error text, "" when models were found.
func (s *Service) runDiscovery(ctx context.Context, a plugins.Agent) string {
	cmdErr := ""
	if mc := a.ModelsCommand; mc != nil {
		got, err := mc.Run(ctx, a.ResolvedEnv())
		if err == nil {
			infos := make([]ModelInfo, len(got))
			for i, m := range got {
				infos[i] = ModelInfo{ID: m.ID, Label: m.Label}
			}
			if s.cache.setCommand(a.ID, infos) {
				s.Refresh()
			}
			return ""
		}
		cmdErr = err.Error()
	}
	models, cur, err := discoverSession(ctx, a)
	if err == nil && len(models) == 0 {
		err = errors.New("the agent advertised no models")
	}
	if err != nil {
		text := shortError(err)
		if cmdErr != "" {
			text = cmdErr + "; " + text
		}
		return text
	}
	s.RecordModels(a.ID, models, cur)
	return ""
}

// discoverSession starts the agent in a fresh empty temporary directory,
// opens a session with no MCP servers and reads the models it advertises. No
// prompt is sent; the process is closed before returning.
func discoverSession(ctx context.Context, a plugins.Agent) ([]ModelInfo, string, error) {
	dir, err := os.MkdirTemp("", "octo-models-*")
	if err != nil {
		return nil, "", err
	}
	defer func() { _ = os.RemoveAll(dir) }()
	client, err := acp.Start(ctx, acp.Spec{Command: a.Command, Args: a.ArgsFor(""), Env: a.ResolvedEnv(), Dir: dir, Name: a.ID})
	if err != nil {
		return nil, "", err
	}
	defer client.Close()
	policy := acp.AuthPolicy{Skip: a.AuthSkip}
	for _, m := range a.AuthMethods {
		policy.Methods = append(policy.Methods, acp.AuthPref{ID: m.ID, RequiresEnv: m.RequiresEnv})
	}
	got, cur, err := client.Discover(ctx, dir, acp.RunOptions{AuthHint: a.Hint, Auth: policy})
	if err != nil {
		return nil, "", err
	}
	out := make([]ModelInfo, len(got))
	for i, m := range got {
		out[i] = ModelInfo{ID: m.ID, Label: m.Label}
	}
	return out, cur, nil
}

// shortError is err as one short line for models_error.
func shortError(err error) string {
	if errors.Is(err, acp.ErrAuthRequired) {
		return "the agent is not logged in"
	}
	msg := strings.Join(strings.Fields(err.Error()), " ")
	if len(msg) > 160 {
		msg = msg[:160] + "..."
	}
	return msg
}
