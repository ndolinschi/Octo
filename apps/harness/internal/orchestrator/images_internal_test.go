package orchestrator

import (
	"strings"
	"testing"
)

const storedUser = `[{"type":"image","attachment_id":"att_aaaaaaaaaaaaaaaaaaaaaaaa","media_type":"image/png","name":"shot.png","width":640,"height":480},{"type":"text","text":"what is this?"}]`

func TestResolveImagesPlaceholderForCompaction(t *testing.T) {
	out := string(resolveImages([]byte(storedUser), nil))
	if !strings.Contains(out, `"text":"[image: shot.png, 640x480]"`) || strings.Contains(out, `"source"`) {
		t.Fatalf("placeholder = %s", out)
	}
	// An image whose bytes are gone also degrades to its placeholder.
	out = string(resolveImages([]byte(storedUser), func(string) (string, bool) { return "", false }))
	if !strings.Contains(out, "[image: shot.png, 640x480]") {
		t.Fatalf("missing bytes = %s", out)
	}
}

func TestResolveImagesLoadsBase64Blocks(t *testing.T) {
	out := string(resolveImages([]byte(storedUser), func(id string) (string, bool) { return "QUJD", id != "" }))
	if !strings.Contains(out, `"type":"image","source":{"data":"QUJD","media_type":"image/png","type":"base64"}`) &&
		!strings.Contains(out, `"source":{"type":"base64"`) && !strings.Contains(out, `"data":"QUJD"`) {
		t.Fatalf("image block = %s", out)
	}
	if !strings.Contains(out, "what is this?") {
		t.Fatalf("text lost: %s", out)
	}
	if got := string(resolveImages([]byte(`[{"type":"text","text":"plain"}]`), nil)); got != `[{"type":"text","text":"plain"}]` {
		t.Fatalf("plain message changed: %s", got)
	}
}

func TestImagePlaceholderName(t *testing.T) {
	if got := imagePlaceholder("", 1, 2); got != "[image: image, 1x2]" {
		t.Fatal(got)
	}
}
