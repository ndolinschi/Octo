package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/anthropics/anthropic-sdk-go/v2"

	"github.com/ndolinschi/Octo/apps/harness/internal/router"
)

// StopReasonCompaction is the stop_reason of a successful router compaction.
const StopReasonCompaction = "compaction"

// compactionSummary reads a router compaction from a response's raw JSON body.
// handled is false when the response is not a compaction (trigger is not
// "compact"); err is set when it is one but failed.
//
// Body shape (the Octo router's "Compaction" contract): the upstream Messages
// JSON, never a stream, with stop_reason "compaction"; the summary is the
// content block of type "compaction" (its "content" string), else the
// concatenated "text" blocks. Anything else, including an empty summary, is a
// failed compaction and the history is left as it is. This is the one place to
// change if the router's format changes.
func compactionSummary(trigger, raw string) (summary string, handled bool, err error) {
	if trigger != router.TriggerCompact {
		return "", false, nil
	}
	var body struct {
		StopReason string `json:"stop_reason"`
		Content    []struct {
			Type    string `json:"type"`
			Text    string `json:"text"`
			Content string `json:"content"`
		} `json:"content"`
	}
	if err := json.Unmarshal([]byte(raw), &body); err != nil {
		return "", true, fmt.Errorf("router compaction: unreadable response: %w", err)
	}
	if body.StopReason != StopReasonCompaction {
		return "", true, fmt.Errorf("router compaction failed: stop_reason %q", body.StopReason)
	}
	var block, text strings.Builder
	for _, c := range body.Content {
		switch c.Type {
		case "compaction":
			block.WriteString(c.Content)
		case "text":
			text.WriteString(c.Text)
		}
	}
	summary = strings.TrimSpace(block.String())
	if summary == "" {
		summary = strings.TrimSpace(text.String())
	}
	if summary == "" {
		return "", true, errors.New("router compaction failed: empty summary")
	}
	return summary, true, nil
}

// SummaryMessage is the single user message that replaces a compacted history.
func SummaryMessage(summary string) anthropic.MessageParam {
	return anthropic.NewUserMessage(anthropic.NewTextBlock(
		"The earlier part of this conversation was compacted. Summary of everything so far:\n\n" +
			summary + "\n\nContinue from where it left off."))
}

// compact stores the summary (when the sink keeps one) and returns the
// shortened history to send from the next request on.
func (l *Loop) compact(ctx context.Context, summary string) ([]anthropic.MessageParam, error) {
	if c, ok := l.Sink.(Compactor); ok {
		if err := c.Compacted(ctx, summary); err != nil {
			return nil, err
		}
	}
	return []anthropic.MessageParam{SummaryMessage(summary)}, nil
}
