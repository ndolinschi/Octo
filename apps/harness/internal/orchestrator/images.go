package orchestrator

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"sync"

	"github.com/anthropics/anthropic-sdk-go/v2"

	"github.com/ndolinschi/Octo/apps/harness/internal/acp"
	"github.com/ndolinschi/Octo/apps/harness/internal/agent"
	"github.com/ndolinschi/Octo/apps/harness/internal/attachments"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

// ImagesUnsupported says the project's agent cannot take images: the message is
// refused before it is sent.
type ImagesUnsupported struct {
	AgentID, Label string
}

func (e *ImagesUnsupported) Error() string {
	return fmt.Sprintf("%s does not accept images", e.Label)
}

// storedImage is the image block of a stored user message: the bytes stay in
// the attachment store, the message keeps the id and what is needed to show a
// thumbnail and to write the compaction placeholder.
type storedImage struct {
	Type         string `json:"type"`
	AttachmentID string `json:"attachment_id"`
	MediaType    string `json:"media_type"`
	Name         string `json:"name,omitempty"`
	Width        int    `json:"width"`
	Height       int    `json:"height"`
}

// imagePlaceholder is what stands for an image where the bytes are not sent
// (a summary's input, an image that is gone).
func imagePlaceholder(name string, w, h int) string {
	if name == "" {
		name = "image"
	}
	return fmt.Sprintf("[image: %s, %dx%d]", name, w, h)
}

// imageLoader returns the base64 data of an attachment.
type imageLoader func(id string) (data string, ok bool)

func (rt *runtime) imageLoader(ctx context.Context) imageLoader {
	return func(id string) (string, bool) {
		c, cancel := dbCtx(ctx)
		defer cancel()
		_, data, err := rt.db.AttachmentData(c, id)
		if err != nil {
			return "", false
		}
		return base64.StdEncoding.EncodeToString(data), true
	}
}

// resolveImages rewrites the stored image blocks of a message's raw content
// into the SDK's base64 image blocks (load != nil and the bytes exist) or into
// text placeholders, and leaves everything else as it is.
func resolveImages(raw []byte, load imageLoader) []byte {
	if !bytes.Contains(raw, []byte(`"attachment_id"`)) {
		return raw
	}
	var blocks []json.RawMessage
	if json.Unmarshal(raw, &blocks) != nil {
		return raw
	}
	for i, b := range blocks {
		var img storedImage
		if json.Unmarshal(b, &img) != nil || img.Type != "image" || img.AttachmentID == "" {
			continue
		}
		var out any
		if load != nil {
			if data, ok := load(img.AttachmentID); ok {
				out = map[string]any{"type": "image", "source": map[string]any{"type": "base64", "media_type": img.MediaType, "data": data}}
			}
		}
		if out == nil {
			out = map[string]any{"type": "text", "text": imagePlaceholder(img.Name, img.Width, img.Height)}
		}
		blocks[i], _ = json.Marshal(out)
	}
	res, err := json.Marshal(blocks)
	if err != nil {
		return raw
	}
	return res
}

// userContent is the stored content of a user message: image blocks in the
// order attached, then the text.
func (rt *runtime) userContent(ctx context.Context, text string, ids []string) ([]byte, error) {
	blocks := make([]any, 0, len(ids)+1)
	for _, id := range ids {
		a, err := rt.db.Attachment(ctx, id)
		if err != nil {
			return nil, fmt.Errorf("attachment %s: %w", id, err)
		}
		blocks = append(blocks, storedImage{Type: "image", AttachmentID: a.ID, MediaType: a.MediaType, Name: a.Name, Width: a.Width, Height: a.Height})
	}
	if text != "" || len(ids) == 0 {
		blocks = append(blocks, anthropic.NewTextBlock(text))
	}
	return json.Marshal(blocks)
}

// imageIDs lists the attachment ids of a stored message, in order.
func imageIDs(m projectstore.Message) []string {
	var ids []string
	for _, b := range m.Content {
		if b.Type == "image" && b.AttachmentID != nil {
			ids = append(ids, *b.AttachmentID)
		}
	}
	return ids
}

// acpImages loads the images of a user message as ACP image blocks.
func (rt *runtime) acpImages(ctx context.Context, m projectstore.Message) []acp.Image {
	load := rt.imageLoader(ctx)
	var out []acp.Image
	for _, b := range m.Content {
		if b.Type != "image" || b.AttachmentID == nil || b.MediaType == nil {
			continue
		}
		if data, ok := load(*b.AttachmentID); ok {
			out = append(out, acp.Image{MimeType: *b.MediaType, Data: data})
		}
	}
	return out
}

// countImages is how many image blocks a history carries, and their estimated tokens.
func countImages(history []anthropic.MessageParam) (n int, tokens int64) {
	for _, m := range history {
		for _, b := range agent.ContentOf(m) {
			if b.OfImage != nil {
				n++
				tokens += imageTokens(b)
			}
		}
	}
	return n, tokens
}

// imageTokens estimates one image block from its decoded header.
func imageTokens(b anthropic.ContentBlockParamUnion) int64 {
	if b.OfImage == nil || b.OfImage.Source.OfBase64 == nil {
		return 1000
	}
	head := b.OfImage.Source.OfBase64.Data
	if len(head) > 4096 {
		head = head[:4096]
	}
	head = head[:len(head)/4*4]
	raw, err := base64.StdEncoding.DecodeString(head)
	if err != nil {
		return 1000
	}
	if info, err := attachments.Describe(raw); err == nil {
		return attachments.Tokens(info.Width, info.Height)
	}
	return 1000
}

// imageCaps remembers which ACP agents advertised promptCapabilities.image.
type imageCaps struct {
	mu sync.Mutex
	m  map[string]bool
}

func (c *imageCaps) set(agentID string, ok bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.m == nil {
		c.m = map[string]bool{}
	}
	c.m[agentID] = ok
}

func (c *imageCaps) get(agentID string) (ok, known bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	ok, known = c.m[agentID]
	return ok, known
}

// ImagesAccepted says whether the project's orchestrator takes images: true
// for the built-in loop, what the agent advertised for an ACP agent. known is
// false while an ACP agent has not been started (nothing says yet); probe
// starts it just to ask.
func (o *Orchestrator) ImagesAccepted(ctx context.Context, pid string, probe bool) (accepts, known bool, label string, err error) {
	db, err := o.store.Get(ctx, pid)
	if err != nil {
		return false, false, "", err
	}
	rt, err := o.newRuntime(ctx, db)
	if err != nil {
		return false, false, "", err
	}
	if !rt.isACPOrchestrator() {
		return true, true, "", nil
	}
	t, err := rt.acpOrchestratorTarget()
	if err != nil {
		return false, false, "", err
	}
	label = t.agent.Label
	if ok, k := o.imgCaps.get(t.agent.ID); k {
		return ok, true, label, nil
	}
	if !probe {
		return false, false, label, nil
	}
	ok, err := rt.probeImages(ctx, t)
	if err != nil {
		return false, false, label, err
	}
	return ok, true, label, nil
}

// probeImages starts the agent only to read its capabilities.
func (rt *runtime) probeImages(ctx context.Context, t acpTarget) (bool, error) {
	ag := t.agent
	client, err := acp.Start(ctx, acp.Spec{
		Command: ag.Command, Args: ag.ArgsFor(t.model), Env: t.processEnv(), Dir: rt.folders[0].Path, Name: ag.ID, Redact: rt.redact,
	})
	if err != nil {
		return false, startFailure(t, err)
	}
	defer client.Close()
	ok := client.Capabilities().PromptImage
	rt.o.imgCaps.set(ag.ID, ok)
	return ok, nil
}

// lastUserImages are the images of the user message the turn answers (the
// newest user message with text).
func (rt *runtime) lastUserImages(ctx context.Context, agentID string) []acp.Image {
	c, cancel := dbCtx(ctx)
	defer cancel()
	msgs, err := rt.db.Messages(c, agentID)
	if err != nil {
		return nil
	}
	for i := len(msgs) - 1; i >= 0; i-- {
		if msgs[i].Role == "user" && messageText(msgs[i]) != "" {
			return rt.acpImages(ctx, msgs[i])
		}
	}
	return nil
}
