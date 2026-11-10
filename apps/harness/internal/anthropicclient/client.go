package anthropicclient

import (
	"encoding/json"
	"net/http"

	"github.com/anthropics/anthropic-sdk-go/v2"
	"github.com/anthropics/anthropic-sdk-go/v2/option"
)

// ResponseObserver is told, for every HTTP response, the host the request went
// to, the model it asked for ("" when unknown) and the response headers. It
// must not retain or modify the header map.
type ResponseObserver func(host, model string, header http.Header)

type options struct{ observer ResponseObserver }

// Option customizes New.
type Option func(*options)

// WithResponseObserver reports each response's headers, including error
// responses such as 429, which carry the freshest rate-limit values.
func WithResponseObserver(o ResponseObserver) Option { return func(c *options) { c.observer = o } }

func New(apiKey, baseURL, octoKey string, opts ...Option) anthropic.Client {
	var cfg options
	for _, o := range opts {
		o(&cfg)
	}
	reqOpts := []option.RequestOption{option.WithAPIKey(apiKey)}
	if baseURL != "" {
		reqOpts = append(reqOpts, option.WithBaseURL(baseURL))
	}
	if octoKey != "" {
		reqOpts = append(reqOpts, option.WithHeader("x-octo-key", octoKey))
	}
	if cfg.observer != nil {
		reqOpts = append(reqOpts, option.WithMiddleware(observe(cfg.observer)))
	}
	return anthropic.NewClient(reqOpts...)
}

func observe(o ResponseObserver) option.Middleware {
	return func(req *http.Request, next option.MiddlewareNext) (*http.Response, error) {
		model := requestModel(req)
		resp, err := next(req)
		if err == nil && resp != nil {
			o(req.URL.Host, model, resp.Header)
		}
		return resp, err
	}
}

// requestModel reads "model" from a copy of the request body.
func requestModel(req *http.Request) string {
	if req.GetBody == nil {
		return ""
	}
	body, err := req.GetBody()
	if err != nil {
		return ""
	}
	defer body.Close()
	var m struct {
		Model string `json:"model"`
	}
	if err := json.NewDecoder(body).Decode(&m); err != nil {
		return ""
	}
	return m.Model
}
