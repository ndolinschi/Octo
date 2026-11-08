package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/anthropics/anthropic-sdk-go/v2"

	"github.com/ndolinschi/Octo/harness/internal/store"
	"github.com/ndolinschi/Octo/harness/internal/tools"
)

type Runner struct {
	Client   anthropic.Client
	Registry *tools.Registry
	Store    *store.Store
	Model    string
	MaxTurns int
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

	userMsg := anthropic.NewUserMessage(anthropic.NewTextBlock(prompt))
	if err := persistMessage(ctx, r.Store, sessionID, "user", userMsg); err != nil {
		return sessionID, "", err
	}

	messages := []anthropic.MessageParam{userMsg}
	toolDefs := r.Registry.AnthropicTools()

	for turn := 1; r.MaxTurns == 0 || turn <= r.MaxTurns; turn++ {
		resp, err := r.Client.Messages.New(ctx, anthropic.MessageNewParams{
			Model:     anthropic.Model(r.Model),
			MaxTokens: 4096,
			Messages:  messages,
			Tools:     toolDefs,
		})
		if err != nil {
			return sessionID, "", err
		}

		assistantBlocks, toolUses, textParts, err := parseAssistantContent(resp.Content)
		if err != nil {
			return sessionID, "", err
		}
		if err := persistMessage(ctx, r.Store, sessionID, "assistant", anthropic.NewAssistantMessage(assistantBlocks...)); err != nil {
			return sessionID, "", err
		}
		messages = append(messages, anthropic.NewAssistantMessage(assistantBlocks...))

		if len(toolUses) == 0 {
			return sessionID, strings.Join(textParts, ""), nil
		}

		if r.MaxTurns > 0 && turn >= r.MaxTurns {
			return sessionID, strings.Join(textParts, ""), nil
		}

		resultBlocks := make([]anthropic.ContentBlockParamUnion, 0, len(toolUses))
		for _, tu := range toolUses {
			block, err := dispatchTool(ctx, r.Registry, tu)
			if err != nil {
				return sessionID, "", err
			}
			resultBlocks = append(resultBlocks, block)
		}

		toolUser := anthropic.NewUserMessage(resultBlocks...)
		if err := persistMessage(ctx, r.Store, sessionID, "user", toolUser); err != nil {
			return sessionID, "", err
		}
		messages = append(messages, toolUser)
	}

	return sessionID, "", fmt.Errorf("agent: exceeded max turns")
}

func parseAssistantContent(content []anthropic.ContentBlockUnion) (
	blocks []anthropic.ContentBlockParamUnion,
	toolUses []anthropic.ToolUseBlock,
	textParts []string,
	err error,
) {
	for _, c := range content {
		switch v := c.AsAny().(type) {
		case anthropic.TextBlock:
			blocks = append(blocks, anthropic.NewTextBlock(v.Text))
			textParts = append(textParts, v.Text)
		case anthropic.ToolUseBlock:
			var input any
			if len(v.Input) > 0 {
				if err := json.Unmarshal(v.Input, &input); err != nil {
					return nil, nil, nil, fmt.Errorf("tool input %q: %w", v.Name, err)
				}
			}
			blocks = append(blocks, anthropic.NewToolUseBlock(v.ID, input, v.Name))
			toolUses = append(toolUses, v)
		default:
			if c.Type == "text" && c.Text != "" {
				blocks = append(blocks, anthropic.NewTextBlock(c.Text))
				textParts = append(textParts, c.Text)
			}
		}
	}
	return blocks, toolUses, textParts, nil
}

func dispatchTool(ctx context.Context, reg *tools.Registry, tu anthropic.ToolUseBlock) (anthropic.ContentBlockParamUnion, error) {
	def, ok := reg.Get(tu.Name)
	if !ok {
		return anthropic.NewToolResultBlock(tu.ID, fmt.Sprintf("unknown tool %q", tu.Name), true), nil
	}
	output, isError, err := def.Handle(ctx, tu.Input)
	if err != nil {
		return anthropic.ContentBlockParamUnion{}, err
	}
	return anthropic.NewToolResultBlock(tu.ID, output, isError), nil
}

func persistMessage(ctx context.Context, st *store.Store, sessionID, role string, msg anthropic.MessageParam) error {
	body, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	return st.AppendMessage(ctx, sessionID, role, body)
}
