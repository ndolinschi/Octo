package projectstore

import "encoding/json"

// ContentBlock is the API-facing block shape.
type ContentBlock struct {
	Type      string          `json:"type"`
	Text      *string         `json:"text,omitempty"`
	ID        *string         `json:"id,omitempty"`
	Name      *string         `json:"name,omitempty"`
	Input     json.RawMessage `json:"input,omitempty"`
	ToolUseID *string         `json:"tool_use_id,omitempty"`
	Content   *string         `json:"content,omitempty"`
	IsError   *bool           `json:"is_error,omitempty"`
	// An image block ("image") names an attachment; Name is its file name.
	AttachmentID *string `json:"attachment_id,omitempty"`
	MediaType    *string `json:"media_type,omitempty"`
	Width        *int    `json:"width,omitempty"`
	Height       *int    `json:"height,omitempty"`
}

type rawBlock struct {
	Type      string          `json:"type"`
	Text      string          `json:"text"`
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Input     json.RawMessage `json:"input"`
	ToolUseID string          `json:"tool_use_id"`
	Content   json.RawMessage `json:"content"`
	IsError   bool            `json:"is_error"`

	AttachmentID string `json:"attachment_id"`
	MediaType    string `json:"media_type"`
	Width        int    `json:"width"`
	Height       int    `json:"height"`
}

// NormalizeContent converts stored SDK content JSON (a block array or a bare
// string) into text / tool_use / tool_result blocks, dropping empty text and
// block types the UI does not render.
func NormalizeContent(raw []byte) []ContentBlock {
	out := []ContentBlock{}
	var asString string
	if json.Unmarshal(raw, &asString) == nil {
		return appendText(out, asString)
	}
	var blocks []rawBlock
	if err := json.Unmarshal(raw, &blocks); err != nil {
		return out
	}
	for _, b := range blocks {
		switch b.Type {
		case "text":
			out = appendText(out, b.Text)
		case "image":
			if b.AttachmentID == "" {
				continue
			}
			id, mt, w, h := b.AttachmentID, b.MediaType, b.Width, b.Height
			blk := ContentBlock{Type: "image", AttachmentID: &id, MediaType: &mt, Width: &w, Height: &h}
			if b.Name != "" {
				name := b.Name
				blk.Name = &name
			}
			out = append(out, blk)
		case "tool_use":
			in := b.Input
			if len(in) == 0 {
				in = json.RawMessage(`{}`)
			}
			id, name := b.ID, b.Name
			out = append(out, ContentBlock{Type: "tool_use", ID: &id, Name: &name, Input: in})
		case "tool_result":
			id, text, isErr := b.ToolUseID, resultText(b.Content), b.IsError
			out = append(out, ContentBlock{Type: "tool_result", ToolUseID: &id, Content: &text, IsError: &isErr})
		}
	}
	return out
}

func appendText(out []ContentBlock, text string) []ContentBlock {
	if text == "" {
		return out
	}
	return append(out, ContentBlock{Type: "text", Text: &text})
}

func resultText(raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var parts []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &parts) != nil {
		return ""
	}
	var text string
	for _, p := range parts {
		if p.Type == "text" {
			text += p.Text
		}
	}
	return text
}
