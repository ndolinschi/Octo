package agent

import "github.com/anthropics/anthropic-sdk-go/v2"

// Prompt caching. Anthropic caches the request prefix in the order tools,
// system, messages up to each cache_control breakpoint (at most 4 per request).
// The loop sets three:
//
//  1. the last tool definition (tools sort by name, so the block is stable),
//  2. the last system block,
//  3. the last cacheable block of the last message, so the whole conversation
//     so far is cached and the next request reads it back.
//
// 1 and 2 are static for the life of a Loop and are set once on the params.
// 3 moves every turn, so it is applied at send time to a copy of the final
// message; the history the caller stores is never modified.

func ephemeral() anthropic.CacheControlEphemeralParam {
	return anthropic.NewCacheControlEphemeralParam()
}

// markStaticPrefix marks the last tool and the last system block. Both slices
// are owned by params, so editing them in place is safe.
func markStaticPrefix(p *anthropic.MessageNewParams) {
	if n := len(p.Tools); n > 0 {
		if t := p.Tools[n-1].OfTool; t != nil {
			c := *t
			c.CacheControl = ephemeral()
			p.Tools[n-1] = anthropic.ToolUnionParam{OfTool: &c}
		}
	}
	if n := len(p.System); n > 0 {
		p.System[n-1].CacheControl = ephemeral()
	}
}

// withMessageBreakpoint returns messages with a breakpoint on the last block of
// the last message that can carry one. Only the last message and the one block
// are copied; every other message is shared with the input and unchanged.
func withMessageBreakpoint(messages []anthropic.MessageParam) []anthropic.MessageParam {
	if len(messages) == 0 {
		return messages
	}
	last := messages[len(messages)-1]
	content := ContentOf(last)
	for i := len(content) - 1; i >= 0; i-- {
		marked, ok := withCacheControl(content[i])
		if !ok {
			continue
		}
		blocks := make([]anthropic.ContentBlockParamUnion, len(content))
		copy(blocks, content)
		blocks[i] = marked
		var msg anthropic.MessageParam
		switch {
		case last.OfUser != nil:
			u := *last.OfUser
			u.Content = blocks
			msg.OfUser = &u
		default:
			a := *last.OfAssistant
			a.Content = blocks
			msg.OfAssistant = &a
		}
		out := make([]anthropic.MessageParam, len(messages))
		copy(out, messages)
		out[len(out)-1] = msg
		return out
	}
	return messages
}

// withCacheControl returns a copy of b carrying a breakpoint. The union holds
// pointers, so the variant struct is copied before it is changed. Thinking
// blocks and other kinds that cannot carry the field report false.
func withCacheControl(b anthropic.ContentBlockParamUnion) (anthropic.ContentBlockParamUnion, bool) {
	switch {
	case b.OfText != nil:
		if b.OfText.Text == "" { // empty text blocks cannot be cached
			return b, false
		}
		c := *b.OfText
		c.CacheControl = ephemeral()
		return anthropic.ContentBlockParamUnion{OfText: &c}, true
	case b.OfToolResult != nil:
		c := *b.OfToolResult
		c.CacheControl = ephemeral()
		return anthropic.ContentBlockParamUnion{OfToolResult: &c}, true
	case b.OfToolUse != nil:
		c := *b.OfToolUse
		c.CacheControl = ephemeral()
		return anthropic.ContentBlockParamUnion{OfToolUse: &c}, true
	case b.OfImage != nil:
		c := *b.OfImage
		c.CacheControl = ephemeral()
		return anthropic.ContentBlockParamUnion{OfImage: &c}, true
	case b.OfDocument != nil:
		c := *b.OfDocument
		c.CacheControl = ephemeral()
		return anthropic.ContentBlockParamUnion{OfDocument: &c}, true
	}
	return b, false
}
