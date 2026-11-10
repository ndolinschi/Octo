package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"

	"github.com/anthropics/anthropic-sdk-go/v2"

	"github.com/ndolinschi/Octo/apps/harness/internal/store"
	"github.com/ndolinschi/Octo/apps/harness/internal/tools"
)

// Runner is the legacy one-shot CLI session: it persists to the session store.
type Runner struct {
	Client    anthropic.Client
	Registry  *tools.Registry
	Store     *store.Store
	Model     string
	MaxTurns  int
	Stream    bool
	StreamOut io.Writer
}

func (r *Runner) Run(ctx context.Context, prompt string) (sessionID string, finalText string, err error) {
	if r.Registry == nil {
		return "", "", fmt.Errorf("agent: registry required")
	}
	if r.Store == nil {
		return "", "", fmt.Errorf("agent: store required")
	}
	if r.Model == "" {
		return "", "", fmt.Errorf("agent: model required")
	}
	sessionID, err = r.Store.CreateSession(ctx, r.Model)
	if err != nil {
		return "", "", err
	}
	sink := &storeSink{store: r.Store, sessionID: sessionID, out: r.StreamOut}
	if sink.out == nil {
		sink.out = os.Stderr
	}
	userMsg := anthropic.NewUserMessage(anthropic.NewTextBlock(prompt))
	if err := sink.Message(ctx, "user", userMsg); err != nil {
		return sessionID, "", err
	}
	loop := Loop{
		Client:    r.Client,
		Registry:  r.Registry,
		Model:     r.Model,
		MaxTurns:  r.MaxTurns,
		Stream:    r.Stream,
		SessionID: sessionID,
		Sink:      sink,
	}
	res, err := loop.Run(ctx, []anthropic.MessageParam{userMsg})
	return sessionID, res.Text, err
}

type storeSink struct {
	store     *store.Store
	sessionID string
	out       io.Writer
}

func (s *storeSink) Message(ctx context.Context, role string, msg anthropic.MessageParam) error {
	body, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	return s.store.AppendMessage(ctx, s.sessionID, role, body)
}

func (s *storeSink) TextDelta(text string) {
	if _, err := io.WriteString(s.out, text); err != nil {
		return
	}
}

func (*storeSink) ToolStarted(string, string) {}
func (*storeSink) ToolFinished(string, bool)  {}
func (*storeSink) Usage(Usage)                {}
