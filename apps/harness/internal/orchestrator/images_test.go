package orchestrator_test

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/fakeacp"
	"github.com/ndolinschi/Octo/apps/harness/internal/orchestrator"
	"github.com/ndolinschi/Octo/apps/harness/internal/plugins"
	"github.com/ndolinschi/Octo/apps/harness/internal/project"
)

func pngBytes(t *testing.T, w, h int) []byte {
	t.Helper()
	m := image.NewRGBA(image.Rect(0, 0, w, h))
	m.Set(1, 1, color.RGBA{G: 200, A: 255})
	var b bytes.Buffer
	if err := png.Encode(&b, m); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

// upload posts raw bytes (or a multipart body) to the attachments endpoint.
func (a *api) upload(pid string, data []byte, contentType string, multipartName string) (int, map[string]any) {
	a.t.Helper()
	body, ct := bytes.NewReader(data), contentType
	var rdr io.Reader = body
	if multipartName != "" {
		var buf bytes.Buffer
		mw := multipart.NewWriter(&buf)
		h := textproto.MIMEHeader{}
		h.Set("Content-Disposition", `form-data; name="file"; filename="`+multipartName+`"`)
		h.Set("Content-Type", contentType)
		p, _ := mw.CreatePart(h)
		_, _ = p.Write(data)
		_ = mw.Close()
		rdr, ct = &buf, mw.FormDataContentType()
	}
	req, err := http.NewRequest("POST", a.url+"/v1/projects/"+pid+"/attachments", rdr)
	if err != nil {
		a.t.Fatal(err)
	}
	req.Header.Set("Content-Type", ct)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		a.t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	out := map[string]any{}
	_ = json.Unmarshal(raw, &out)
	return resp.StatusCode, out
}

func TestAttachmentUploadLimitsAndSniffing(t *testing.T) {
	r := newRig(t, mockllmStub())
	pid := r.project(t, 1)
	a := r.api(t)
	data := pngBytes(t, 30, 20)

	st, body := a.upload(pid, data, "application/octet-stream", "")
	if st != 201 || body["media_type"] != "image/png" || body["width"] != float64(30) || body["height"] != float64(20) {
		t.Fatalf("raw upload = %d %v", st, body)
	}
	id := body["id"].(string)
	st, body2 := a.upload(pid, data, "image/png", "shot.png")
	if st != 201 || body2["id"] != id || body2["name"] != "shot.png" {
		t.Fatalf("multipart upload = %d %v (same content must be the same id %s)", st, body2, id)
	}
	// The header is not trusted: HTML sent as image/png is refused.
	if st, body := a.upload(pid, []byte("<html><script>x</script></html>"), "image/png", ""); st != 415 {
		t.Fatalf("html as png = %d %v", st, body)
	}
	if st, _ := a.upload(pid, []byte("%PDF-1.7 ..."), "application/pdf", ""); st != 415 {
		t.Fatalf("pdf = %d", st)
	}
	big := append(append([]byte{}, data...), bytes.Repeat([]byte("x"), 5<<20)...)
	if st, body := a.upload(pid, big, "image/png", ""); st != 413 {
		t.Fatalf("6 MB = %d %v", st, body)
	}
	if st, _ := a.upload(pid, nil, "image/png", ""); st != 400 {
		t.Fatalf("empty = %d", st)
	}
	// Read it back.
	resp, err := http.Get(a.url + "/v1/projects/" + pid + "/attachments/" + id)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || resp.Header.Get("Content-Type") != "image/png" || !bytes.Equal(got, data) {
		t.Fatalf("get = %d %s %d bytes", resp.StatusCode, resp.Header.Get("Content-Type"), len(got))
	}
	if st, _ := a.do("GET", "/v1/projects/"+pid+"/attachments/att_000000000000000000000000", nil); st != 404 {
		t.Fatalf("unknown id = %d", st)
	}
	if st, _ := a.do("GET", "/v1/projects/"+pid+"/attachments/..%2F..%2Fproject.sqlite", nil); st != 404 {
		t.Fatalf("path id = %d", st)
	}
}

func TestMessageWithImagesReachesTheBuiltInLoopAsImageBlocks(t *testing.T) {
	llm := &scripted{}
	r := newRig(t, llm)
	pid := r.project(t, 1)
	a := r.api(t)
	_, up := a.upload(pid, pngBytes(t, 40, 30), "image/png", "a.png")
	_, up2 := a.upload(pid, pngBytes(t, 41, 30), "image/png", "b.png")
	ids := []string{up["id"].(string), up2["id"].(string)}

	// Unknown ids, too many, and duplicates are refused.
	if st, _ := a.do("POST", "/v1/projects/"+pid+"/messages", map[string]any{"text": "x", "attachments": []string{"att_000000000000000000000000"}}); st != 404 {
		t.Fatalf("unknown attachment = %d", st)
	}
	nine := make([]string, 9)
	for i := range nine {
		nine[i] = ids[0]
	}
	if st, _ := a.do("POST", "/v1/projects/"+pid+"/messages", map[string]any{"text": "x", "attachments": nine}); st != 400 {
		t.Fatalf("nine attachments = %d", st)
	}

	st, body := a.do("POST", "/v1/projects/"+pid+"/messages", map[string]any{"text": "what is in these?", "attachments": ids})
	if st != 202 {
		t.Fatalf("post = %d %v", st, body)
	}
	waitUntil(t, "the turn to end", func() bool { return !r.orch.Running(pid) && len(llm.seen) > 0 })

	var req struct {
		Messages []struct {
			Role    string `json:"role"`
			Content []struct {
				Type   string `json:"type"`
				Text   string `json:"text"`
				Source struct {
					Type      string `json:"type"`
					MediaType string `json:"media_type"`
					Data      string `json:"data"`
				} `json:"source"`
			} `json:"content"`
		} `json:"messages"`
	}
	llm.mu.Lock()
	raw := llm.seen[0].Body
	llm.mu.Unlock()
	if err := json.Unmarshal([]byte(raw), &req); err != nil {
		t.Fatal(err)
	}
	c := req.Messages[0].Content
	if len(c) != 3 || c[0].Type != "image" || c[1].Type != "image" || c[2].Type != "text" || c[2].Text != "what is in these?" {
		t.Fatalf("content = %+v", c)
	}
	if c[0].Source.MediaType != "image/png" || c[0].Source.Data == "" || c[0].Source.Data == c[1].Source.Data {
		t.Fatalf("image sources = %+v %+v", c[0].Source, c[1].Source)
	}

	// The stored message keeps ids, not bytes; the transcript carries what a thumbnail needs.
	orch := r.agents(t, pid)[0]
	msgs, err := r.svc.Messages(context.Background(), pid, orch.ID)
	if err != nil {
		t.Fatal(err)
	}
	var imgs int
	for _, b := range msgs[0].Content {
		if b.Type == "image" {
			imgs++
			if b.AttachmentID == nil || b.Width == nil || *b.Width == 0 || b.Name == nil {
				t.Fatalf("image block = %+v", b)
			}
		}
	}
	if imgs != 2 {
		t.Fatalf("stored image blocks = %d", imgs)
	}
	if raw, _ := json.Marshal(msgs[0]); strings.Contains(string(raw), "iVBOR") {
		t.Fatal("the transcript carries the image bytes")
	}

	// The context report counts them.
	rep, err := r.svc.Context(context.Background(), pid, "")
	if err != nil {
		t.Fatal(err)
	}
	if rep.Images != 2 || rep.ImageTokens <= 0 {
		t.Fatalf("context images = %d tokens %d", rep.Images, rep.ImageTokens)
	}
}

func imageAgent(image bool) plugins.Agent {
	a := fakeAgent("fake", true)
	a.Launch.Env[fakeacp.EnvUniqueSessions] = "1"
	if image {
		a.Launch.Env[fakeacp.EnvPromptImage] = "1"
	}
	return a
}

func imageRig(t *testing.T, image bool) (*rig, string) {
	t.Helper()
	r := newRigWith(t, mockllmStub(), orchestrator.Options{Agents: []plugins.Agent{imageAgent(image)}})
	name := "p"
	p, err := r.svcWithAgents(t, imageAgent(image)).Create(context.Background(), project.Input{
		Name: &name, Folders: &[]project.FolderInput{{Path: t.TempDir()}}, Models: &config.Models{Orchestrator: "acp:fake"},
	})
	if err != nil {
		t.Fatal(err)
	}
	return r, p.ID
}

func TestImagesReachAnACPAgentThatAdvertisedThem(t *testing.T) {
	r, pid := imageRig(t, true)
	a := r.api(t)
	data := pngBytes(t, 10, 10)
	_, up := a.upload(pid, data, "image/png", "s.png")
	st, body := a.do("POST", "/v1/projects/"+pid+"/messages", map[string]any{"text": "[blocks] look", "attachments": []string{up["id"].(string)}})
	if st != 202 {
		t.Fatalf("post = %d %v", st, body)
	}
	waitUntil(t, "the turn to end", func() bool { return !r.orch.Running(pid) && r.lastOrchestratorText(t, pid) != "" })
	if got := r.lastOrchestratorText(t, pid); !strings.Contains(got, "blocks=image:image/png:") || !strings.HasSuffix(got, ",text") {
		t.Fatalf("agent saw %q", got)
	}
	// Once the agent has run, the project says it takes images.
	_, proj := a.do("GET", "/v1/projects/"+pid, nil)
	if proj["accepts_images"] != true {
		t.Fatalf("accepts_images = %v", proj["accepts_images"])
	}
}

func TestImagesRefusedBeforeSendingWhenTheAgentCannotTakeThem(t *testing.T) {
	r, pid := imageRig(t, false)
	a := r.api(t)
	_, proj := a.do("GET", "/v1/projects/"+pid, nil)
	if v, present := proj["accepts_images"]; !present || v != nil {
		t.Fatalf("accepts_images before the agent started = %v (want null)", v)
	}
	_, up := a.upload(pid, pngBytes(t, 10, 10), "image/png", "s.png")
	st, body := a.do("POST", "/v1/projects/"+pid+"/messages", map[string]any{"text": "look", "attachments": []string{up["id"].(string)}})
	e, _ := body["error"].(map[string]any)
	if st != 422 || e["code"] != "images_unsupported" || !strings.Contains(e["message"].(string), "Fake fake") {
		t.Fatalf("post = %d %v", st, body)
	}
	if r.orch.Running(pid) {
		t.Fatal("a turn started")
	}
	orch := r.agents(t, pid)[0]
	if msgs, _ := r.svc.Messages(context.Background(), pid, orch.ID); len(msgs) != 0 {
		t.Fatalf("a refused message was stored: %d", len(msgs))
	}
	_, proj = a.do("GET", "/v1/projects/"+pid, nil)
	if proj["accepts_images"] != false {
		t.Fatalf("accepts_images after the probe = %v", proj["accepts_images"])
	}
}

func TestQueuedMessageKeepsItsImages(t *testing.T) {
	r, pid := imageRig(t, true)
	a := r.api(t)
	_, up := a.upload(pid, pngBytes(t, 10, 10), "image/png", "q.png")
	id := up["id"].(string)
	if st, _ := a.do("POST", "/v1/projects/"+pid+"/messages", map[string]any{"text": "[hang] first"}); st != 202 {
		t.Fatal("first message")
	}
	waitUntil(t, "the turn to run", func() bool { return r.orch.Running(pid) })
	st, body := a.do("POST", "/v1/projects/"+pid+"/messages", map[string]any{"text": "[blocks] second", "attachments": []string{id}})
	q, _ := body["queued"].(map[string]any)
	if st != 202 || q == nil {
		t.Fatalf("queued post = %d %v", st, body)
	}
	if att, _ := q["attachments"].([]any); len(att) != 1 || att[0] != id {
		t.Fatalf("queued entry = %v", q)
	}
	_, qs := a.do("GET", "/v1/projects/"+pid+"/queue", nil)
	if msgs, _ := qs["messages"].([]any); len(msgs) != 1 || msgs[0].(map[string]any)["attachments"] == nil {
		t.Fatalf("queue = %v", qs)
	}
	// It cannot be injected into a running ACP turn.
	if st, _ := a.do("POST", "/v1/projects/"+pid+"/queue/"+q["id"].(string)+"/send-now", nil); st != 409 {
		t.Fatalf("send-now = %d", st)
	}
	// Interrupting runs it, with the image.
	if st, _ := a.do("POST", "/v1/projects/"+pid+"/queue/"+q["id"].(string)+"/send-now", map[string]any{"interrupt": true}); st != 204 && st != 202 && st != 200 {
		t.Fatalf("send-now interrupt = %d", st)
	}
	waitUntil(t, "the queued turn to end", func() bool {
		return !r.orch.Running(pid) && strings.Contains(r.lastOrchestratorText(t, pid), "blocks=")
	})
	if got := r.lastOrchestratorText(t, pid); !strings.Contains(got, "image:image/png") {
		t.Fatalf("agent saw %q", got)
	}
}

func TestPruneAttachmentsKeepsReferencedOnes(t *testing.T) {
	r := newRig(t, &scripted{})
	pid := r.project(t, 1)
	a := r.api(t)
	_, kept := a.upload(pid, pngBytes(t, 10, 10), "image/png", "kept.png")
	_, gone := a.upload(pid, pngBytes(t, 11, 10), "image/png", "gone.png")
	if st, _ := a.do("POST", "/v1/projects/"+pid+"/messages", map[string]any{"text": "hi", "attachments": []string{kept["id"].(string)}}); st != 202 {
		t.Fatal("post")
	}
	waitUntil(t, "the turn to end", func() bool { return !r.orch.Running(pid) })
	db, err := r.store.Get(context.Background(), pid)
	if err != nil {
		t.Fatal(err)
	}
	n, err := db.PruneAttachments(context.Background(), "9999-01-01T00:00:00.000Z")
	if err != nil || n != 1 {
		t.Fatalf("pruned %d %v, want 1", n, err)
	}
	if st, _ := a.do("GET", "/v1/projects/"+pid+"/attachments/"+gone["id"].(string), nil); st != 404 {
		t.Fatalf("pruned attachment = %d", st)
	}
	if st := rawStatus(t, a.url+"/v1/projects/"+pid+"/attachments/"+kept["id"].(string)); st != 200 {
		t.Fatalf("referenced attachment = %d", st)
	}
	if _, err := os.Stat(filepath.Join(r.store.ProjectDir(pid), "attachments")); err != nil {
		t.Fatal(err)
	}
}

func rawStatus(t *testing.T, url string) int {
	t.Helper()
	resp, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	return resp.StatusCode
}
