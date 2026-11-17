package browserproxy

import (
	"bytes"
	"fmt"
	"html"
	"io"
	"mime"
	"net/http"
	"strconv"
	"strings"
)

const maxInspectableHTML = 8 << 20 // 8 MiB

func (i *instance) modifyResponse(resp *http.Response) error {
	if resp.StatusCode == http.StatusSwitchingProtocols {
		return nil
	}

	h := resp.Header
	h.Del("X-Frame-Options")
	h.Del("Cross-Origin-Opener-Policy")
	h.Del("Cross-Origin-Embedder-Policy")
	h.Del("Cross-Origin-Resource-Policy")
	rewriteCSP(h, "Content-Security-Policy")
	rewriteCSP(h, "Content-Security-Policy-Report-Only")

	if loc := h.Get("Location"); loc != "" && strings.HasPrefix(loc, i.targetOrigin) {
		rest := strings.TrimPrefix(loc, i.targetOrigin)
		if rest == "" {
			rest = "/"
		}
		h.Set("Location", rest)
	}

	if setCookies := h.Values("Set-Cookie"); len(setCookies) > 0 {
		h.Del("Set-Cookie")
		for _, raw := range setCookies {
			h.Add("Set-Cookie", rewriteSetCookie(raw))
		}
	}

	if resp.StatusCode == http.StatusNoContent || resp.StatusCode == http.StatusNotModified || resp.Body == nil {
		return nil
	}
	if resp.Request != nil && resp.Request.Method == http.MethodHead {
		return nil
	}
	if h.Get("Content-Encoding") != "" {
		return nil
	}
	mt, _, err := mime.ParseMediaType(h.Get("Content-Type"))
	if err != nil || !isRewritableMediaType(mt) {
		return nil
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxInspectableHTML+1))
	if err != nil {
		_ = resp.Body.Close()
		return err
	}
	if len(body) > maxInspectableHTML {
		origBody := resp.Body
		resp.Body = struct {
			io.Reader
			io.Closer
		}{
			Reader: io.MultiReader(bytes.NewReader(body), origBody),
			Closer: origBody,
		}
		return nil
	}
	if closeErr := resp.Body.Close(); closeErr != nil {
		return closeErr
	}

	rewritten := i.rewriteBodyOrigins(body)
	if mt == "text/html" {
		rewritten = injectInspectorTag(rewritten, i.nonce, i.targetOrigin)
	}
	resp.Body = io.NopCloser(bytes.NewReader(rewritten))
	h.Set("Content-Length", strconv.Itoa(len(rewritten)))
	return nil
}

func isRewritableMediaType(mt string) bool {
	switch mt {
	case "text/html", "text/css", "application/javascript", "text/javascript", "application/x-javascript", "application/json":
		return true
	default:
		return false
	}
}

func (i *instance) rewriteBodyOrigins(body []byte) []byte {
	out := body
	target := []byte(i.targetOrigin)
	if len(target) > 0 && bytes.Contains(out, target) {
		out = bytes.ReplaceAll(out, target, []byte(i.proxyOrigin))
	}
	wsScheme := "ws://"
	if i.target.Scheme == "https" {
		wsScheme = "wss://"
	}
	wsTarget := []byte(wsScheme + i.target.Host)
	if bytes.Contains(out, wsTarget) {
		out = bytes.ReplaceAll(out, wsTarget, []byte("ws://"+i.proxyHost))
	}
	return out
}

func injectInspectorTag(doc []byte, nonce, targetOrigin string) []byte {
	tag := fmt.Sprintf(
		`<script src="%s" data-octo-nonce="%s" data-octo-target-origin="%s" defer></script>`,
		inspectorURI,
		html.EscapeString(nonce),
		html.EscapeString(targetOrigin),
	)
	lower := bytes.ToLower(doc)
	for _, needle := range [][]byte{[]byte("</head>"), []byte("</body>")} {
		if idx := bytes.Index(lower, needle); idx >= 0 {
			out := make([]byte, 0, len(doc)+len(tag))
			out = append(out, doc[:idx]...)
			out = append(out, tag...)
			out = append(out, doc[idx:]...)
			return out
		}
	}
	out := make([]byte, 0, len(doc)+len(tag))
	out = append(out, doc...)
	out = append(out, tag...)
	return out
}

func rewriteCSP(h http.Header, headerName string) {
	vals := h.Values(headerName)
	if len(vals) == 0 {
		return
	}
	h.Del(headerName)
	for _, v := range vals {
		parts := strings.Split(v, ";")
		kept := make([]string, 0, len(parts)+3)
		var defaultTokens []string
		hasScriptSrc := false
		hasStyleSrc := false
		hasImgSrc := false
		for _, raw := range parts {
			d := strings.TrimSpace(raw)
			if d == "" {
				continue
			}
			fields := strings.Fields(d)
			name := strings.ToLower(fields[0])
			switch name {
			case "frame-ancestors", "upgrade-insecure-requests", "block-all-mixed-content":
				continue
			case "default-src":
				defaultTokens = fields[1:]
			case "script-src", "script-src-elem":
				if name == "script-src" {
					hasScriptSrc = true
				}
				cleaned := filterOutToken(fields[1:], "'strict-dynamic'")
				d = ensureTokens(fields[0]+" "+strings.Join(cleaned, " "), cleaned, "'self'")
			case "style-src", "style-src-elem", "style-src-attr":
				if name == "style-src" {
					hasStyleSrc = true
				}
				d = ensureTokens(d, fields[1:], "'self'", "'unsafe-inline'")
			case "img-src":
				hasImgSrc = true
				d = ensureTokens(d, fields[1:], "'self'", "data:", "blob:")
			}
			kept = append(kept, d)
		}
		if len(defaultTokens) > 0 {
			base := filterOutToken(defaultTokens, "'none'")
			if !hasScriptSrc {
				kept = append(kept, ensureTokens("script-src "+strings.Join(base, " "), base, "'self'"))
			}
			if !hasStyleSrc {
				kept = append(kept, ensureTokens("style-src "+strings.Join(base, " "), base, "'self'", "'unsafe-inline'"))
			}
			if !hasImgSrc {
				kept = append(kept, ensureTokens("img-src "+strings.Join(base, " "), base, "'self'", "data:", "blob:"))
			}
		}
		if len(kept) > 0 {
			h.Add(headerName, strings.Join(kept, "; "))
		}
	}
}

func filterOutToken(tokens []string, drop string) []string {
	out := make([]string, 0, len(tokens))
	for _, t := range tokens {
		if !strings.EqualFold(t, drop) {
			out = append(out, t)
		}
	}
	return out
}

func ensureTokens(directive string, existing []string, want ...string) string {
	d := strings.TrimSpace(directive)
	if containsToken(existing, "*") {
		for _, w := range want {
			if strings.HasPrefix(w, "'") || strings.HasSuffix(w, ":") {
				if !containsToken(existing, w) {
					d += " " + w
				}
			}
		}
		return d
	}
	for _, w := range want {
		if !containsToken(existing, w) {
			d += " " + w
		}
	}
	return d
}

func containsToken(list []string, want string) bool {
	for _, item := range list {
		if strings.EqualFold(item, want) {
			return true
		}
	}
	return false
}

func rewriteSetCookie(raw string) string {
	parts := strings.Split(raw, ";")
	out := make([]string, 0, len(parts))
	for idx, p := range parts {
		trimmed := strings.TrimSpace(p)
		if idx == 0 {
			out = append(out, trimmed)
			continue
		}
		lower := strings.ToLower(trimmed)
		if lower == "secure" || strings.HasPrefix(lower, "domain=") {
			continue
		}
		if strings.HasPrefix(lower, "samesite=none") {
			out = append(out, "SameSite=Lax")
			continue
		}
		out = append(out, trimmed)
	}
	return strings.Join(out, "; ")
}
