package lsp_test

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"strings"
	"testing"
	"testing/iotest"

	"github.com/ndolinschi/Octo/apps/harness/internal/lsp"
)

func frame(body string) string { return fmt.Sprintf("Content-Length: %d\r\n\r\n%s", len(body), body) }

func readAll(t *testing.T, r io.Reader, max int) ([]string, error) {
	t.Helper()
	fr := lsp.NewFrameReader(r, max)
	var out []string
	for {
		b, err := fr.Read()
		if errors.Is(err, io.EOF) {
			return out, nil
		}
		if err != nil {
			return out, err
		}
		out = append(out, string(b))
	}
}

func TestFrameReaderValid(t *testing.T) {
	a, b := `{"a":1}`, `{"b":"é"}`
	tests := []struct {
		name string
		in   string
		wrap func(io.Reader) io.Reader
		want []string
	}{
		{"single", frame(a), nil, []string{a}},
		{"two in one read", frame(a) + frame(b), nil, []string{a, b}},
		{"one byte at a time", frame(a) + frame(b), iotest.OneByteReader, []string{a, b}},
		{"half reads", frame(a) + frame(b), iotest.HalfReader, []string{a, b}},
		{"content type tolerated", "Content-Type: application/vscode-jsonrpc; charset=utf-8\r\n" + frame(a), nil, []string{a}},
		{"header case and spacing", "content-length:   7  \r\n\r\n" + a, nil, []string{a}},
		{"bare LF line endings", "Content-Length: 7\n\n" + a, nil, []string{a}},
		{"empty stream", "", nil, nil},
		{"zero length body", "Content-Length: 0\r\n\r\n", nil, []string{""}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var r io.Reader = strings.NewReader(tt.in)
			if tt.wrap != nil {
				r = tt.wrap(r)
			}
			got, err := readAll(t, r, 1<<20)
			if err != nil {
				t.Fatal(err)
			}
			if strings.Join(got, "|") != strings.Join(tt.want, "|") || len(got) != len(tt.want) {
				t.Fatalf("got %q, want %q", got, tt.want)
			}
		})
	}
}

func TestFrameReaderErrors(t *testing.T) {
	tests := []struct {
		name string
		in   string
		max  int
		want error
	}{
		{"missing length", "Content-Type: x\r\n\r\n{}", 100, lsp.ErrBadFrame},
		{"non numeric length", "Content-Length: abc\r\n\r\n{}", 100, lsp.ErrBadFrame},
		{"negative length", "Content-Length: -1\r\n\r\n", 100, lsp.ErrBadFrame},
		{"header without colon", "Content-Length 2\r\n\r\n{}", 100, lsp.ErrBadFrame},
		{"oversized", "Content-Length: 101\r\n\r\n", 100, lsp.ErrTooLarge},
		{"huge length", "Content-Length: 99999999999\r\n\r\n", 100, lsp.ErrBadFrame},
		{"header too long", "X: " + strings.Repeat("a", 70<<10) + "\r\n", 100, lsp.ErrBadFrame},
		{"too many header bytes", strings.Repeat("X: "+strings.Repeat("a", 1000)+"\r\n", 10), 100, lsp.ErrBadFrame},
		{"truncated body", "Content-Length: 10\r\n\r\n{}", 100, io.ErrUnexpectedEOF},
		{"truncated headers", "Content-Length: 2\r\n", 100, io.ErrUnexpectedEOF},
		{"eof inside header line", "Content-Len", 100, io.ErrUnexpectedEOF},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := readAll(t, strings.NewReader(tt.in), tt.max)
			if !errors.Is(err, tt.want) {
				t.Fatalf("err = %v, want %v", err, tt.want)
			}
		})
	}
}

func TestWriteMessage(t *testing.T) {
	var buf bytes.Buffer
	if err := lsp.WriteMessage(&buf, []byte(`{"a":1}`), 100); err != nil {
		t.Fatal(err)
	}
	if got, want := buf.String(), "Content-Length: 7\r\n\r\n{\"a\":1}"; got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
	if err := lsp.WriteMessage(&buf, bytes.Repeat([]byte("x"), 101), 100); !errors.Is(err, lsp.ErrTooLarge) {
		t.Fatalf("err = %v, want ErrTooLarge", err)
	}
}

func TestWriteReadRoundTrip(t *testing.T) {
	var buf bytes.Buffer
	body := `{"jsonrpc":"2.0","method":"x","params":{"s":"` + strings.Repeat("ü", 5000) + `"}}`
	if err := lsp.WriteMessage(&buf, []byte(body), lsp.MaxMessageSize); err != nil {
		t.Fatal(err)
	}
	got, err := readAll(t, iotest.OneByteReader(&buf), lsp.MaxMessageSize)
	if err != nil || len(got) != 1 || got[0] != body {
		t.Fatalf("round trip failed: %v", err)
	}
}
