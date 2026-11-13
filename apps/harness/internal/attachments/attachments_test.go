package attachments

import (
	"bytes"
	"encoding/binary"
	"errors"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"strings"
	"testing"
)

func img(w, h int) image.Image {
	m := image.NewRGBA(image.Rect(0, 0, w, h))
	m.Set(0, 0, color.RGBA{R: 255, A: 255})
	return m
}

func encoded(t *testing.T, kind string, w, h int) []byte {
	t.Helper()
	var b bytes.Buffer
	var err error
	switch kind {
	case "png":
		err = png.Encode(&b, img(w, h))
	case "jpeg":
		err = jpeg.Encode(&b, img(w, h), nil)
	case "gif":
		p := image.NewPaletted(image.Rect(0, 0, w, h), color.Palette{color.Black, color.White})
		err = gif.Encode(&b, p, nil)
	}
	if err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func webp(chunk string, payload []byte) []byte {
	body := append([]byte("WEBP"+chunk), 0, 0, 0, 0)
	binary.LittleEndian.PutUint32(body[8:], uint32(len(payload)))
	body = append(body, payload...)
	out := append([]byte("RIFF"), 0, 0, 0, 0)
	binary.LittleEndian.PutUint32(out[4:], uint32(len(body)))
	return append(out, body...)
}

func TestDescribeSniffsTheContent(t *testing.T) {
	vp8 := append([]byte{0, 0, 0, 0x9d, 0x01, 0x2a}, 40, 0, 30, 0)
	vp8l := []byte{0x2f, 0, 0, 0, 0, 0, 0, 0, 0, 0}
	binary.LittleEndian.PutUint32(vp8l[1:], uint32(63)|uint32(31)<<14)
	vp8x := append([]byte{0, 0, 0, 0}, 99, 0, 0, 49, 0, 0)
	cases := []struct {
		name string
		data []byte
		typ  string
		w, h int
	}{
		{"png", encoded(t, "png", 12, 7), PNG, 12, 7},
		{"jpeg", encoded(t, "jpeg", 20, 10), JPEG, 20, 10},
		{"gif", encoded(t, "gif", 5, 6), GIF, 5, 6},
		{"webp lossy", webp("VP8 ", vp8), WebP, 40, 30},
		{"webp lossless", webp("VP8L", vp8l), WebP, 64, 32},
		{"webp extended", webp("VP8X", vp8x), WebP, 100, 50},
	}
	for _, c := range cases {
		info, err := Describe(c.data)
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if info.MediaType != c.typ || info.Width != c.w || info.Height != c.h || !ValidID(info.ID) || info.Bytes != int64(len(c.data)) {
			t.Fatalf("%s: %+v", c.name, info)
		}
	}
	a, _ := Describe(cases[0].data)
	b, _ := Describe(cases[0].data)
	if a.ID != b.ID {
		t.Fatal("the id is not content-addressed")
	}
}

func TestDescribeRefusesWhatIsNotAnImage(t *testing.T) {
	for name, data := range map[string][]byte{
		"text":        []byte("hello"),
		"svg":         []byte(`<svg xmlns="http://www.w3.org/2000/svg"/>`),
		"pdf":         []byte("%PDF-1.7"),
		"html":        []byte("<html><script>alert(1)</script>"),
		"png header":  []byte("\x89PNG\r\n\x1a\nnot really"),
		"bare riff":   []byte("RIFF\x00\x00\x00\x00WEBPVP8 ........"),
		"bmp":         append([]byte("BM"), make([]byte, 60)...),
		"jpeg prefix": []byte("\xff\xd8\xffgarbage"),
	} {
		if _, err := Describe(data); !errors.Is(err, ErrUnsupported) {
			t.Fatalf("%s: err = %v, want unsupported", name, err)
		}
	}
	if _, err := Describe(nil); !errors.Is(err, ErrEmpty) {
		t.Fatalf("empty: %v", err)
	}
}

func TestDescribeLimit(t *testing.T) {
	big := append(encoded(t, "png", 4, 4), []byte(strings.Repeat("x", MaxBytes))...)
	if _, err := Describe(big); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("err = %v, want too large", err)
	}
}

func TestTokens(t *testing.T) {
	if Tokens(750, 750) != 750 || Tokens(1, 1) != 1 || Tokens(4000, 4000) != 1600 {
		t.Fatal("tokens")
	}
}
