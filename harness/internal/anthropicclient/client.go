package anthropicclient

import (
	"github.com/anthropics/anthropic-sdk-go/v2"
	"github.com/anthropics/anthropic-sdk-go/v2/option"
)

func New(apiKey, baseURL, octoKey string) anthropic.Client {
	opts := []option.RequestOption{option.WithAPIKey(apiKey)}
	if baseURL != "" {
		opts = append(opts, option.WithBaseURL(baseURL))
	}
	if octoKey != "" {
		opts = append(opts, option.WithHeader("x-octo-key", octoKey))
	}
	return anthropic.NewClient(opts...)
}
