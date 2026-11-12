// Package webfetch is the web_fetch tool: one GET of an http(s) URL, returned
// as text. It sends nothing of the project (no cookies, no headers or body from
// it, no proxy), refuses private, loopback and link-local addresses unless the
// caller allows them (checked on the address actually connected to, so a DNS
// answer cannot slip one in, and again on every redirect), stops after 15 s,
// and keeps at most 200 kB of the body.
package webfetch

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"mime"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/ndolinschi/Octo/apps/harness/internal/tools"
)

// Tool is the tool's name.
const Tool = "web_fetch"

// Limits.
const (
	MaxBytes     = 200_000
	Timeout      = 15 * time.Second
	maxRedirects = 5
	maxURLLen    = 2048
)

// Description and Schema are the tool's definition.
const Description = "Fetch a web page or text document with one GET request and return it as text (HTML is converted to plain text; at most 200 kB). " +
	"Only http and https URLs; no cookies or credentials are sent, and addresses on the local network are refused."

var Schema = json.RawMessage(`{"type":"object","properties":{"url":{"type":"string","description":"The http:// or https:// URL to fetch"}},"required":["url"]}`)

// Config tunes a fetch. The zero value is the strict default.
type Config struct {
	// AllowPrivate lets the fetch reach private, loopback and link-local addresses.
	AllowPrivate bool
	// Redact, when set, is applied to the URL first: a URL that holds a stored
	// secret is refused, and to the text that comes back.
	Redact func(string) string
	// Timeout and MaxBytes override the defaults (tests).
	Timeout  time.Duration
	MaxBytes int
}

// ErrPrivate is returned for a refused address.
var ErrPrivate = errors.New("the address is private, loopback or link-local; the project does not allow web_fetch to reach it")

// Handler is the tool handler for cfg.
func Handler(cfg Config) tools.Handler {
	return func(ctx context.Context, input json.RawMessage) (string, bool, error) {
		var in struct {
			URL string `json:"url"`
		}
		if err := json.Unmarshal(input, &in); err != nil {
			return err.Error(), true, nil
		}
		out, err := Fetch(ctx, cfg, in.URL)
		if err != nil {
			return "web_fetch: " + err.Error(), true, nil
		}
		return out, false, nil
	}
}

// ParseURL validates a URL for web_fetch: http or https, a host, no credentials in it.
func ParseURL(raw string) (*url.URL, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, errors.New("url is required")
	}
	if len(raw) > maxURLLen {
		return nil, errors.New("url is too long")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("invalid url: %w", err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return nil, errors.New("only http and https URLs can be fetched")
	}
	if u.Hostname() == "" {
		return nil, errors.New("url has no host")
	}
	if u.User != nil {
		return nil, errors.New("a url with credentials in it is refused")
	}
	u.Fragment = ""
	return u, nil
}

// Fetch GETs rawURL and returns a header line and the text of the body.
func Fetch(ctx context.Context, cfg Config, rawURL string) (string, error) {
	u, err := ParseURL(rawURL)
	if err != nil {
		return "", err
	}
	if cfg.Redact != nil && cfg.Redact(u.String()) != u.String() {
		return "", errors.New("the url holds a stored secret; it is not sent")
	}
	if !cfg.AllowPrivate && literalPrivate(u.Hostname()) {
		return "", ErrPrivate
	}
	timeout, limit := cfg.Timeout, cfg.MaxBytes
	if timeout <= 0 {
		timeout = Timeout
	}
	if limit <= 0 {
		limit = MaxBytes
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	client := &http.Client{
		Timeout:   timeout,
		Transport: transport(cfg.AllowPrivate),
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) > maxRedirects {
				return errors.New("too many redirects")
			}
			if _, err := ParseURL(req.URL.String()); err != nil {
				return fmt.Errorf("redirect refused: %w", err)
			}
			if !cfg.AllowPrivate && literalPrivate(req.URL.Hostname()) {
				return ErrPrivate
			}
			req.Header.Del("Referer") // the client sets it on a redirect; nothing but the model's own URL goes out
			return nil
		},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", "octo-harness-web-fetch")
	req.Header.Set("Accept", "text/html,text/plain,application/json;q=0.9,*/*;q=0.1")
	resp, err := client.Do(req)
	if err != nil {
		if errors.Is(err, ErrPrivate) {
			return "", ErrPrivate
		}
		var ue *url.Error
		if errors.As(err, &ue) {
			err = ue.Err
		}
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return "", fmt.Errorf("timed out after %s", timeout)
		}
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return "", fmt.Errorf("HTTP %s", resp.Status)
	}
	ctype := resp.Header.Get("Content-Type")
	media, _, _ := mime.ParseMediaType(ctype)
	if !textual(media) {
		return "", fmt.Errorf("unsupported content type %q: web_fetch returns text only", media)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, int64(limit)+1))
	if err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return "", fmt.Errorf("timed out after %s", timeout)
		}
		return "", err
	}
	cut := len(body) > limit
	if cut {
		body = body[:limit]
	}
	text := strings.ToValidUTF8(string(body), "�")
	if cut {
		text = clipRunes(text, limit)
	}
	if strings.Contains(media, "html") {
		text = HTMLToText(text)
	}
	if cfg.Redact != nil {
		text = cfg.Redact(text)
	}
	var b strings.Builder
	fmt.Fprintf(&b, "[web_fetch] %s (%d, %s)\n\n", resp.Request.URL.String(), resp.StatusCode, media)
	b.WriteString(strings.TrimSpace(text))
	if cut {
		fmt.Fprintf(&b, "\n\n[web_fetch: the response was cut at %d kB]", limit/1000)
	}
	return b.String(), nil
}

// literalPrivate: host is an IP address literal that Private refuses.
func literalPrivate(host string) bool {
	ip, err := netip.ParseAddr(strings.Trim(host, "[]"))
	return err == nil && Private(ip)
}

func clipRunes(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}

func textual(media string) bool {
	switch {
	case strings.HasPrefix(media, "text/"), media == "":
		return true
	case media == "application/json", media == "application/xml", media == "application/javascript",
		media == "application/x-yaml", media == "application/yaml", media == "application/xhtml+xml",
		strings.HasSuffix(media, "+json"), strings.HasSuffix(media, "+xml"):
		return true
	}
	return false
}

// transport has no proxy, no cookies and a dialer that checks every address it connects to.
func transport(allowPrivate bool) *http.Transport {
	d := &net.Dialer{Timeout: Timeout}
	if !allowPrivate {
		d.Control = func(_, address string, _ syscall.RawConn) error {
			host, _, err := net.SplitHostPort(address)
			if err != nil {
				return ErrPrivate
			}
			ip, err := netip.ParseAddr(host)
			if err != nil || Private(ip) {
				return ErrPrivate
			}
			return nil
		}
	}
	return &http.Transport{
		Proxy:                  nil,
		DialContext:            d.DialContext,
		DisableKeepAlives:      true,
		TLSHandshakeTimeout:    10 * time.Second,
		ResponseHeaderTimeout:  Timeout,
		MaxResponseHeaderBytes: 64 << 10,
	}
}

var privateNets = func() []netip.Prefix {
	var out []netip.Prefix
	for _, s := range []string{
		"0.0.0.0/8", "100.64.0.0/10", "192.0.0.0/24", "198.18.0.0/15", "240.0.0.0/4", // this-network, CGNAT, IETF, benchmarking, reserved
		"64:ff9b::/96", "2002::/16", // NAT64 and 6to4 embed an IPv4 address: judged by it below
	} {
		out = append(out, netip.MustParsePrefix(s))
	}
	return out
}()

// Private reports whether ip is an address web_fetch refuses by default:
// loopback, private ranges, link-local (the cloud metadata address included),
// multicast, unspecified, carrier-grade NAT and other reserved ranges; an
// IPv4 address embedded in an IPv6 one is judged as the IPv4 address.
func Private(ip netip.Addr) bool {
	ip = ip.Unmap()
	if ip.Is6() {
		b := ip.As16()
		switch {
		case netip.MustParsePrefix("64:ff9b::/96").Contains(ip):
			return Private(netip.AddrFrom4([4]byte{b[12], b[13], b[14], b[15]}))
		case netip.MustParsePrefix("2002::/16").Contains(ip):
			return Private(netip.AddrFrom4([4]byte{b[2], b[3], b[4], b[5]}))
		}
	}
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() ||
		ip.IsInterfaceLocalMulticast() || ip.IsMulticast() || ip.IsUnspecified() {
		return true
	}
	for _, p := range privateNets {
		if p.Contains(ip) && !p.Addr().Is6() {
			return true
		}
	}
	return false
}

// HTMLToText turns an HTML document into plain text: scripts, styles and
// comments dropped, block elements as line breaks, list items as "- ", the
// title first, entities decoded, blank runs collapsed.
func HTMLToText(src string) string {
	title := ""
	var b strings.Builder
	i := 0
	lower := strings.ToLower(src)
	for i < len(src) {
		if src[i] != '<' {
			j := strings.IndexByte(src[i:], '<')
			if j < 0 {
				j = len(src) - i
			}
			b.WriteString(src[i : i+j])
			i += j
			continue
		}
		if strings.HasPrefix(src[i:], "<!--") {
			if j := strings.Index(src[i:], "-->"); j >= 0 {
				i += j + 3
			} else {
				i = len(src)
			}
			continue
		}
		end := strings.IndexByte(src[i:], '>')
		if end < 0 {
			break
		}
		tag := lower[i+1 : i+end]
		i += end + 1
		name := tag
		closing := strings.HasPrefix(name, "/")
		name = strings.TrimPrefix(name, "/")
		if k := strings.IndexAny(name, " \t\r\n/"); k >= 0 {
			name = name[:k]
		}
		if !closing {
			switch name {
			case "script", "style", "noscript", "svg", "template", "iframe":
				if j := strings.Index(lower[i:], "</"+name); j >= 0 {
					i += j
					if k := strings.IndexByte(src[i:], '>'); k >= 0 {
						i += k + 1
					} else {
						i = len(src)
					}
				} else {
					i = len(src)
				}
				continue
			case "title":
				if j := strings.Index(lower[i:], "</title"); j >= 0 && title == "" {
					title = strings.TrimSpace(html.UnescapeString(src[i : i+j]))
				}
				if j := strings.Index(lower[i:], "</title>"); j >= 0 {
					i += j + len("</title>")
				}
				continue
			}
		}
		switch name {
		case "br", "p", "div", "section", "article", "header", "footer", "main", "nav", "aside", "ul", "ol", "table", "tr",
			"h1", "h2", "h3", "h4", "h5", "h6", "pre", "blockquote", "hr", "form", "dl", "dt", "dd", "figure":
			b.WriteString("\n")
		case "li":
			b.WriteString("\n")
			if !closing {
				b.WriteString("- ")
			}
		case "td", "th":
			b.WriteString(" ")
		}
	}
	text := html.UnescapeString(b.String())
	var out []string
	blank := 0
	for _, line := range strings.Split(text, "\n") {
		line = strings.Join(strings.Fields(strings.ReplaceAll(line, " ", " ")), " ")
		if line == "" {
			if blank++; blank > 1 {
				continue
			}
		} else {
			blank = 0
		}
		out = append(out, line)
	}
	res := strings.TrimSpace(strings.Join(out, "\n"))
	if title != "" {
		res = "Title: " + title + "\n\n" + res
	}
	return res
}
