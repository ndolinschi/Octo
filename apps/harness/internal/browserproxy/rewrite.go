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
	mt, _, err := mime.ParseMediaType(h.Get("Content-Type"))
	if err != nil || mt != "text/html" {
		return nil
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxInspectableHTML+1))
	closeErr := resp.Body.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if len(body) > maxInspectableHTML {
		resp.Body = io.NopCloser(bytes.NewReader(body))
		h.Del("Content-Length")
		return nil
	}

	injected := injectInspectorTag(body, i.nonce, i.targetOrigin)
	resp.Body = io.NopCloser(bytes.NewReader(injected))
	h.Set("Content-Length", strconv.Itoa(len(injected)))
	return nil
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
			case "frame-ancestors":
				continue
			case "default-src":
				defaultTokens = fields[1:]
			case "script-src", "script-src-elem":
				if name == "script-src" {
					hasScriptSrc = true
				}
				d = ensureTokens(d, fields[1:], "'self'")
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
			base := filterOutNone(defaultTokens)
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

func filterOutNone(tokens []string) []string {
	out := make([]string, 0, len(tokens))
	for _, t := range tokens {
		if !strings.EqualFold(t, "'none'") {
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
