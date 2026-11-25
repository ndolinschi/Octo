package fakerouter

import (
	"bufio"
	"bytes"
	"encoding/json"
	"net/http"
)

// capture passes the response through and keeps a copy to read token counts from.
type capture struct {
	http.ResponseWriter
	buf bytes.Buffer
}

func (c *capture) Write(p []byte) (int, error) {
	c.buf.Write(p)
	return c.ResponseWriter.Write(p)
}

func (c *capture) Flush() {
	if f, ok := c.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

type usageBody struct {
	Usage   *usage `json:"usage"`
	Message *struct {
		Usage *usage `json:"usage"`
	} `json:"message"`
}

type usage struct {
	In    int `json:"input_tokens"`
	Out   int `json:"output_tokens"`
	Cache int `json:"cache_read_input_tokens"`
	Write int `json:"cache_creation_input_tokens"`
}

// tokens reads input and output tokens from a JSON or SSE response body.
func (c *capture) tokens() (in, out int) {
	var whole usageBody
	if json.Unmarshal(c.buf.Bytes(), &whole) == nil && whole.Usage != nil {
		return whole.Usage.In + whole.Usage.Cache + whole.Usage.Write, whole.Usage.Out
	}
	sc := bufio.NewScanner(&c.buf)
	sc.Buffer(make([]byte, 0, 64*1024), 8<<20)
	for sc.Scan() {
		line := sc.Bytes()
		if !bytes.HasPrefix(line, []byte("data: ")) {
			continue
		}
		var ev usageBody
		if json.Unmarshal(line[6:], &ev) != nil {
			continue
		}
		if ev.Message != nil && ev.Message.Usage != nil {
			in = ev.Message.Usage.In + ev.Message.Usage.Cache + ev.Message.Usage.Write
		}
		if ev.Usage != nil && ev.Usage.Out > 0 {
			out = ev.Usage.Out
		}
	}
	return in, out
}
