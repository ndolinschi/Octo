package lsp

import (
	"bufio"
	"bytes"
	"fmt"
	"io"
	"strconv"
	"strings"
)

// MaxMessageSize bounds one JSON-RPC message in either direction.
const MaxMessageSize = 4 << 20

const (
	readerBuffer   = 64 << 10
	maxHeaderBytes = 8 << 10
)

// FrameReader reads LSP base-protocol messages (`Content-Length: N`, blank
// line, N bytes of JSON). Headers other than Content-Length are ignored, so
// Content-Type is tolerated.
type FrameReader struct {
	br  *bufio.Reader
	max int
}

// NewFrameReader rejects any message larger than max bytes.
func NewFrameReader(r io.Reader, max int) *FrameReader {
	return &FrameReader{br: bufio.NewReaderSize(r, readerBuffer), max: max}
}

// Read returns the next message body. It returns io.EOF only at a clean
// message boundary; any framing violation is fatal because the stream cannot
// be resynchronised.
func (f *FrameReader) Read() ([]byte, error) {
	length, err := f.readHeaders()
	if err != nil {
		return nil, err
	}
	body := make([]byte, length)
	if _, err := io.ReadFull(f.br, body); err != nil {
		if err == io.EOF {
			err = io.ErrUnexpectedEOF
		}
		return nil, err
	}
	return body, nil
}

func (f *FrameReader) readHeaders() (int, error) {
	length, seen, total := -1, false, 0
	for {
		line, err := f.br.ReadSlice('\n')
		total += len(line)
		switch {
		case err == bufio.ErrBufferFull || total > maxHeaderBytes:
			return 0, fmt.Errorf("%w: header too long", ErrBadFrame)
		case err == io.EOF && !seen && len(line) == 0:
			return 0, io.EOF
		case err == io.EOF:
			return 0, io.ErrUnexpectedEOF
		case err != nil:
			return 0, err
		}
		seen = true
		text := strings.TrimRight(string(line), "\r\n")
		if text == "" {
			if length < 0 {
				return 0, fmt.Errorf("%w: missing Content-Length", ErrBadFrame)
			}
			return length, nil
		}
		name, value, ok := strings.Cut(text, ":")
		if !ok {
			return 0, fmt.Errorf("%w: header without colon", ErrBadFrame)
		}
		if !strings.EqualFold(strings.TrimSpace(name), "Content-Length") {
			continue
		}
		n, err := strconv.ParseUint(strings.TrimSpace(value), 10, 31)
		if err != nil {
			return 0, fmt.Errorf("%w: bad Content-Length %q", ErrBadFrame, strings.TrimSpace(value))
		}
		if int(n) > f.max {
			return 0, fmt.Errorf("%w: %d bytes (limit %d)", ErrTooLarge, n, f.max)
		}
		length = int(n)
	}
}

// WriteMessage frames msg and writes it with a single Write call.
func WriteMessage(w io.Writer, msg []byte, max int) error {
	if len(msg) > max {
		return fmt.Errorf("%w: %d bytes (limit %d)", ErrTooLarge, len(msg), max)
	}
	var buf bytes.Buffer
	buf.Grow(len(msg) + 32)
	fmt.Fprintf(&buf, "Content-Length: %d\r\n\r\n", len(msg))
	buf.Write(msg)
	_, err := w.Write(buf.Bytes())
	return err
}
