package providers

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

// Model API states as `harness doctor` and GET /v1/diagnostics report them.
const (
	ModelReachable    = "reachable"
	ModelUnreachable  = "unreachable"
	ModelUnauthorized = "unauthorized"
)

// ProbeModelAPI asks the Messages API at base (the built-in loop's base URL;
// "" is the Anthropic API) for its model list with the key, within the same
// short timeout as the Ollama reachability probe: nothing answering is
// unreachable, 401/403 is unauthorized, any other answer is reachable. detail
// says what was seen (never the key).
func ProbeModelAPI(ctx context.Context, base, apiKey, octoKey string) (state, detail string) {
	if strings.TrimSpace(base) == "" {
		base = "https://api.anthropic.com"
	}
	target := strings.TrimRight(base, "/") + "/v1/models"
	shown := base // what the details say: no credentials, no query
	if u, err := url.Parse(base); err == nil {
		t := *u
		t.Path = strings.TrimRight(u.Path, "/") + "/v1/models"
		target = t.String()
		u.User, u.RawQuery, u.Fragment = nil, "", ""
		shown = u.String()
	}
	ctx, cancel := context.WithTimeout(ctx, reachTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return ModelUnreachable, "the base URL is not valid"
	}
	req.Header.Set("anthropic-version", "2023-06-01")
	if apiKey != "" {
		req.Header.Set("x-api-key", apiKey)
	}
	if octoKey != "" {
		req.Header.Set("x-octo-key", octoKey)
	}
	resp, err := reachClient.Do(req)
	if err != nil {
		var ue *url.Error
		if errors.As(err, &ue) {
			err = ue.Err
		}
		return ModelUnreachable, fmt.Sprintf("nothing answered at %s within %s: %v", shown, reachTimeout, err)
	}
	_ = resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusUnauthorized, http.StatusForbidden:
		return ModelUnauthorized, fmt.Sprintf("%s refused the key (HTTP %d)", shown, resp.StatusCode)
	}
	return ModelReachable, fmt.Sprintf("%s answered (HTTP %d)", shown, resp.StatusCode)
}
