package settings

import (
	"errors"
	"net/url"
)

// validBaseURL accepts an http(s) URL with a host and no credentials, query or
// fragment: the base URL of an external Octo router.
func validBaseURL(s string) error {
	u, err := url.Parse(s)
	if err != nil || u.Host == "" || u.Hostname() == "" {
		return errors.New("must be an http:// or https:// URL")
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return errors.New("must be an http:// or https:// URL")
	}
	if u.User != nil {
		return errors.New("must not contain credentials")
	}
	if u.RawQuery != "" || u.Fragment != "" {
		return errors.New("must not contain a query or fragment")
	}
	return nil
}
