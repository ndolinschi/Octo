package fakeacp

import (
	"encoding/json"
	"fmt"
	"os"
	"slices"
	"strings"
)

// authCustom is the auth mode selected by EnvAuthMethods.
const authCustom = "custom"

func splitList(v string) []string {
	var out []string
	for _, s := range strings.Split(v, ",") {
		if s = strings.TrimSpace(s); s != "" {
			out = append(out, s)
		}
	}
	return out
}

func (o *options) loadAuthMethods() {
	o.authOK = splitList(os.Getenv(EnvAuthOK))
	o.authLog = os.Getenv(EnvAuthLog)
	o.reportEnv = splitList(os.Getenv(EnvReportEnv))
	raw := os.Getenv(EnvAuthMethods)
	if raw == "" {
		return
	}
	if err := json.Unmarshal([]byte(raw), &o.methods); err != nil {
		fmt.Fprintln(os.Stderr, "fakeacp: bad", EnvAuthMethods+":", err)
		return
	}
	o.auth = authCustom
}

// authenticateCustom serves authenticate under EnvAuthMethods and records the
// attempt.
func (a *agent) authenticateCustom(m message, id string) {
	if a.opts.authLog != "" {
		f, err := os.OpenFile(a.opts.authLog, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
		if err == nil {
			_, _ = f.WriteString(id + "\n")
			_ = f.Close()
		}
	}
	if !slices.Contains(a.opts.authOK, id) {
		a.respondError(m.ID, -32000, "authentication failed for "+id)
		return
	}
	a.mu.Lock()
	a.authed = true
	a.mu.Unlock()
	a.respond(m.ID, map[string]any{})
}

// envReport describes which of the requested variables the agent can see.
func (a *agent) envReport() string {
	if len(a.opts.reportEnv) == 0 {
		return ""
	}
	parts := make([]string, len(a.opts.reportEnv))
	for i, n := range a.opts.reportEnv {
		state := "unset"
		if _, ok := os.LookupEnv(n); ok {
			state = "set"
		}
		parts[i] = n + "=" + state
	}
	return " Env: " + strings.Join(parts, ", ") + "."
}
