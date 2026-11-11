package diag

import (
	"bytes"
	"context"
	"log"
	"log/slog"
	"regexp"
	"strings"
	"sync"
)

// LogRing keeps the last lines the harness logged, scrubbed of anything that
// looks like a credential. It wraps the real handler: lines still go there.
type LogRing struct {
	mu    sync.Mutex
	lines []string
	max   int
	text  slog.Handler
	buf   *bytes.Buffer
}

// NewLogRing makes a ring of n lines.
func NewLogRing(n int) *LogRing {
	buf := &bytes.Buffer{}
	return &LogRing{max: n, buf: buf, text: slog.NewTextHandler(buf, &slog.HandlerOptions{Level: slog.LevelDebug})}
}

// Wrap returns a handler that records into the ring and passes records to next.
func (r *LogRing) Wrap(next slog.Handler) slog.Handler { return &ringHandler{ring: r, next: next} }

type ringHandler struct {
	ring *LogRing
	next slog.Handler
	// attrs/group of derived handlers are not recorded: the ring formats the
	// record with its own text handler.
}

func (h *ringHandler) Enabled(ctx context.Context, l slog.Level) bool { return h.next.Enabled(ctx, l) }

func (h *ringHandler) Handle(ctx context.Context, rec slog.Record) error {
	h.ring.add(rec)
	return h.next.Handle(ctx, rec)
}

func (h *ringHandler) WithAttrs(a []slog.Attr) slog.Handler {
	return &ringHandler{ring: h.ring, next: h.next.WithAttrs(a)}
}

func (h *ringHandler) WithGroup(n string) slog.Handler {
	return &ringHandler{ring: h.ring, next: h.next.WithGroup(n)}
}

func (r *LogRing) add(rec slog.Record) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.buf.Reset()
	if err := r.text.Handle(context.Background(), rec); err != nil {
		return
	}
	line := Scrub(strings.TrimRight(r.buf.String(), "\n"))
	r.lines = append(r.lines, line)
	if len(r.lines) > r.max {
		r.lines = r.lines[len(r.lines)-r.max:]
	}
}

// Lines returns the last n recorded lines.
func (r *LogRing) Lines(n int) []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	l := r.lines
	if len(l) > n {
		l = l[len(l)-n:]
	}
	return append([]string{}, l...)
}

var (
	kvSecret = regexp.MustCompile(`(?i)([A-Za-z0-9_.-]*(?:key|token|secret|password|passwd|credential|authorization)[A-Za-z0-9_.-]*)(=|:\s*)("[^"]*"|\S+)`)
	bearer   = regexp.MustCompile(`(?i)(bearer|basic)\s+[A-Za-z0-9._~+/=-]{6,}`)
	urlCreds = regexp.MustCompile(`(://)[^/\s:@]+:[^/\s@]+@`)
	skLike   = regexp.MustCompile(`\b(sk|pk|xai|ghp|gho|github_pat|glpat|AKIA)[-_A-Za-z0-9]{10,}`)
)

// Scrub removes credential-looking text from a log line.
func Scrub(s string) string {
	s = urlCreds.ReplaceAllString(s, "${1}[redacted]@")
	s = bearer.ReplaceAllString(s, "$1 [redacted]")
	s = kvSecret.ReplaceAllString(s, "${1}${2}[redacted]")
	return skLike.ReplaceAllString(s, "[redacted]")
}

// legacy writes records the way slog's default handler does ("LEVEL msg k=v",
// timestamp from the log.Logger), through its own *log.Logger. Wrapping the
// default handler itself would deadlock: slog.SetDefault points the log package
// at the new handler, which would write through the log package again.
type legacy struct {
	l      *log.Logger
	opts   *slog.HandlerOptions
	attrs  []slog.Attr
	groups []string
}

// LegacyHandler is a handler with the output format of slog's default handler.
func LegacyHandler(l *log.Logger) slog.Handler {
	return &legacy{l: l, opts: &slog.HandlerOptions{ReplaceAttr: func(groups []string, a slog.Attr) slog.Attr {
		if len(groups) == 0 && (a.Key == slog.TimeKey || a.Key == slog.LevelKey || a.Key == slog.MessageKey) {
			return slog.Attr{}
		}
		return a
	}}}
}

func (h *legacy) Enabled(_ context.Context, l slog.Level) bool { return l >= slog.LevelInfo }

func (h *legacy) Handle(ctx context.Context, rec slog.Record) error {
	var buf bytes.Buffer
	var th slog.Handler = slog.NewTextHandler(&buf, h.opts)
	th = th.WithAttrs(h.attrs)
	for _, g := range h.groups {
		th = th.WithGroup(g)
	}
	if err := th.Handle(ctx, rec); err != nil {
		return err
	}
	attrs := strings.TrimSpace(buf.String())
	line := rec.Level.String() + " " + rec.Message
	if attrs != "" {
		line += " " + attrs
	}
	return h.l.Output(0, line)
}

func (h *legacy) WithAttrs(a []slog.Attr) slog.Handler {
	c := *h
	c.attrs = append(append([]slog.Attr{}, h.attrs...), a...)
	return &c
}

func (h *legacy) WithGroup(n string) slog.Handler {
	c := *h
	c.groups = append(append([]string{}, h.groups...), n)
	return &c
}
