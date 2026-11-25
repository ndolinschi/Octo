// Package attachments describes the images a user attaches to a message: it
// decides what a byte string is by sniffing its content (never by trusting a
// header or a file name), measures it and names it by its hash.
package attachments

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"image"
	_ "image/gif" // registers the decoder for image.DecodeConfig
	_ "image/jpeg"
	_ "image/png"
	"regexp"
)

// Limits of an attachment.
const (
	// MaxBytes is the largest image the harness stores (after the client downsized it).
	MaxBytes = 5 << 20
	// MaxPerMessage is the most images one message or queued message carries.
	MaxPerMessage = 8
)

// Media types the harness accepts.
const (
	PNG  = "image/png"
	JPEG = "image/jpeg"
	WebP = "image/webp"
	GIF  = "image/gif"
)

// Errors of Describe.
var (
	ErrTooLarge    = errors.New("attachments: the image is larger than 5 MB")
	ErrUnsupported = errors.New("attachments: not a PNG, JPEG, WebP or GIF image")
	ErrEmpty       = errors.New("attachments: empty file")
)

// Info is what Describe learns of an image.
type Info struct {
	// ID is "att_" and the first 24 hex digits of the SHA-256 of the content:
	// the same image uploaded twice is one attachment.
	ID        string
	SHA256    string
	MediaType string
	Bytes     int64
	Width     int
	Height    int
}

var idPattern = regexp.MustCompile(`^att_[0-9a-f]{24}$`)

// ValidID reports whether s has the shape of an attachment id.
func ValidID(s string) bool { return idPattern.MatchString(s) }

// Describe sniffs data: its type from the leading bytes, its size from the
// image header. Content that is not one of the four types, or whose header
// cannot be read, is ErrUnsupported; more than MaxBytes is ErrTooLarge.
func Describe(data []byte) (Info, error) {
	switch {
	case len(data) == 0:
		return Info{}, ErrEmpty
	case len(data) > MaxBytes:
		return Info{}, ErrTooLarge
	}
	typ, w, h := sniff(data)
	if typ == "" || w <= 0 || h <= 0 {
		return Info{}, ErrUnsupported
	}
	sum := sha256.Sum256(data)
	hexSum := hex.EncodeToString(sum[:])
	return Info{ID: "att_" + hexSum[:24], SHA256: hexSum, MediaType: typ, Bytes: int64(len(data)), Width: w, Height: h}, nil
}

func sniff(data []byte) (typ string, w, h int) {
	switch {
	case bytes.HasPrefix(data, []byte("\x89PNG\r\n\x1a\n")):
		typ = PNG
	case bytes.HasPrefix(data, []byte("\xff\xd8\xff")):
		typ = JPEG
	case bytes.HasPrefix(data, []byte("GIF87a")), bytes.HasPrefix(data, []byte("GIF89a")):
		typ = GIF
	case len(data) >= 12 && string(data[0:4]) == "RIFF" && string(data[8:12]) == "WEBP":
		w, h = webpSize(data)
		if w > 0 {
			return WebP, w, h
		}
		return "", 0, 0
	default:
		return "", 0, 0
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return "", 0, 0
	}
	return typ, cfg.Width, cfg.Height
}

// webpSize reads the canvas size from the first chunk of a WebP file (lossy
// VP8, lossless VP8L or extended VP8X); 0, 0 when it cannot.
func webpSize(d []byte) (w, h int) {
	if len(d) < 30 {
		return 0, 0
	}
	switch string(d[12:16]) {
	case "VP8 ":
		if d[23] != 0x9d || d[24] != 0x01 || d[25] != 0x2a {
			return 0, 0
		}
		return int(binary.LittleEndian.Uint16(d[26:28]) & 0x3fff), int(binary.LittleEndian.Uint16(d[28:30]) & 0x3fff)
	case "VP8L":
		if d[20] != 0x2f {
			return 0, 0
		}
		bits := binary.LittleEndian.Uint32(d[21:25])
		return int(bits&0x3fff) + 1, int((bits>>14)&0x3fff) + 1
	case "VP8X":
		return 1 + (int(d[24]) | int(d[25])<<8 | int(d[26])<<16), 1 + (int(d[27]) | int(d[28])<<8 | int(d[29])<<16)
	}
	return 0, 0
}

// Tokens estimates what an image of this size costs the model (width x height
// / 750, as Anthropic documents, at most 1 600).
func Tokens(w, h int) int64 {
	t := int64(w) * int64(h) / 750
	return min(max(t, 1), 1600)
}
