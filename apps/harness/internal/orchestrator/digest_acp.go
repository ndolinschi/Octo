package orchestrator

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"

	"github.com/ndolinschi/Octo/apps/harness/internal/acp"
	"github.com/ndolinschi/Octo/apps/harness/internal/memory"
)

// errNoLiveSession: the ACP orchestrator has no live session to ask.
var errNoLiveSession = errors.New("the ACP orchestrator has no live session to ask for the digest")

// digestAsk is the instruction that follows the digest prompt in the live session.
const digestAsk = "\n\nThis is a bookkeeping request from the harness, not from the user: answer with the JSON object only, " +
	"in one message; do not use tools and do not continue the work."

// askACPDigest asks the orchestrator's agent, in its live session, for the
// turn's digest: one prompt, ACPDigestTimeout, answered by a handler that
// keeps the text and stores nothing, so the exchange never shows in the
// conversation. The session's digestMu keeps the next turn from starting its
// prompt while this one is open.
func (rt *runtime) askACPDigest(ctx context.Context, w memory.TurnWork) (*memory.Digest, error) {
	s := rt.o.acp.session(rt.pid())
	s.digestMu.Lock()
	defer s.digestMu.Unlock()
	s.mu.Lock()
	client, sessID, alive := s.client, s.sessID, s.aliveLocked() && s.sessID != "" && !s.busy
	s.mu.Unlock()
	if !alive {
		return nil, errNoLiveSession
	}
	ctx, cancel := context.WithTimeout(ctx, ACPDigestTimeout)
	defer cancel()
	h := &digestHandler{rt: rt}
	stop, err := client.PromptWith(ctx, sessID, memory.DigestPrompt+"\n\n"+rt.digestInput(ctx, w)+digestAsk, nil, h)
	if err != nil {
		return nil, fmt.Errorf("digest prompt: %w", err)
	}
	if stop != acp.StopEndTurn {
		return nil, fmt.Errorf("the agent stopped with %q instead of answering", stop)
	}
	d, err := memory.ParseDigest(h.answer())
	if err != nil {
		return nil, err
	}
	return &d, nil
}

// digestHandler is the acp.Handler of the digest prompt: it keeps the agent's
// text and refuses every permission request and file access.
type digestHandler struct {
	rt   *runtime
	mu   sync.Mutex
	text strings.Builder
}

func (h *digestHandler) AgentText(_ context.Context, text string) {
	h.mu.Lock()
	h.text.WriteString(text)
	h.mu.Unlock()
}

func (h *digestHandler) answer() string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.rt.redact(h.text.String())
}

func (h *digestHandler) ToolCall(context.Context, acp.ToolCall)             {}
func (h *digestHandler) ToolCallUpdate(context.Context, acp.ToolCallUpdate) {}
func (h *digestHandler) Usage(context.Context, acp.Usage)                   {}

func (h *digestHandler) RequestPermission(_ context.Context, req acp.PermissionRequest) string {
	if o, ok := req.FirstOption(acp.RejectOnce, acp.RejectAlways); ok {
		return o.ID
	}
	return ""
}

func (h *digestHandler) ReadTextFile(context.Context, acp.ReadTextFileParams) (string, error) {
	return "", errors.New("refused: this is a bookkeeping prompt; answer with the JSON object")
}

func (h *digestHandler) WriteTextFile(context.Context, acp.WriteTextFileParams) error {
	return errors.New("refused: this is a bookkeeping prompt; answer with the JSON object")
}
