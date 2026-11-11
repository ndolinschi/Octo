// Package childenv builds the environment of every process the harness starts:
// the bash tool, ACP agents, language servers and login probes.
//
// It is an allow-list. A child gets only the variables that are permitted
// below, everything else in the harness's own environment is dropped, so a
// provider key the harness has never heard of (MISTRAL_API_KEY, GITHUB_TOKEN,
// AWS_*, HF_TOKEN ...) does not leak into a shell command or a CLI.
package childenv

import (
	"log/slog"
	"os"
	"strings"
	"sync/atomic"
)

// AllowEnvVar names the operator's extra allow-list: comma separated exact
// names and PREFIX_* patterns, read once at start-up.
const AllowEnvVar = "HARNESS_CHILD_ENV_ALLOW"

// Always allowed, exact (upper-case) names.
var allowExact = map[string]bool{
	// Identity, shell, locale, terminal, time zone, temp dirs.
	"PATH": true, "HOME": true, "USER": true, "LOGNAME": true, "SHELL": true,
	"LANG": true, "LANGUAGE": true, "TERM": true, "COLORTERM": true, "TZ": true,
	"TMPDIR": true, "TEMP": true, "TMP": true, "PWD": true, "HOSTNAME": true,
	// Display servers (GUI tools, browsers started by tests).
	"DISPLAY": true, "WAYLAND_DISPLAY": true,
	// Git over ssh needs the agent socket. This is the one deliberate
	// exception to the secret rules: it is a socket path, not a secret, but the
	// child can ask the agent to sign, so it is allowed on purpose.
	"SSH_AUTH_SOCK": true,
	// Proxy and TLS settings: a build behind a proxy or a private CA fails
	// without them.
	"HTTP_PROXY": true, "HTTPS_PROXY": true, "NO_PROXY": true, "ALL_PROXY": true,
	"SSL_CERT_FILE": true, "SSL_CERT_DIR": true, "NODE_EXTRA_CA_CERTS": true,
	"REQUESTS_CA_BUNDLE": true, "CURL_CA_BUNDLE": true, "GIT_SSL_CAINFO": true,
	// Toolchain locations and switches that hold no secrets.
	"GOPATH": true, "GOROOT": true, "GOCACHE": true, "GOMODCACHE": true, "GOFLAGS": true,
	"GOTOOLCHAIN": true, "GOPROXY": true, "GONOSUMDB": true, "GONOPROXY": true,
	"GOSUMDB": true, "GOPRIVATE": true,
	"GOOS": true, "GOARCH": true, "CGO_ENABLED": true, // cross builds
	"CC": true, "CXX": true, // C toolchain chosen by the user (cgo, node-gyp)
	"CARGO_HOME": true, "RUSTUP_HOME": true, "CARGO_TARGET_DIR": true,
	"NVM_DIR": true, "NODE_PATH": true, "PNPM_HOME": true, "JAVA_HOME": true,
	"PYTHONPATH": true, "VIRTUAL_ENV": true, "CONDA_PREFIX": true,
	// Output behaviour that test runners and CLIs read.
	"CI": true, "NO_COLOR": true, "FORCE_COLOR": true,
	// Version control and build tools: identity, editor and pager choices,
	// config and ssh command, native library search paths (names and paths,
	// not credentials; GIT_ASKPASS and tokens stay out).
	"GIT_AUTHOR_NAME": true, "GIT_AUTHOR_EMAIL": true, "GIT_COMMITTER_NAME": true, "GIT_COMMITTER_EMAIL": true,
	"GIT_EDITOR": true, "GIT_PAGER": true, "GIT_TERMINAL_PROMPT": true, "GIT_CONFIG_GLOBAL": true, "GIT_SSH_COMMAND": true,
	"PKG_CONFIG_PATH": true, "LD_LIBRARY_PATH": true, "DYLD_LIBRARY_PATH": true, "LIBRARY_PATH": true, "CPATH": true,
	"RUSTUP_TOOLCHAIN": true, "RUSTFLAGS": true,
	// Where container and cloud CLIs find their configuration, not what they
	// authenticate with.
	"DOCKER_HOST": true, "DOCKER_CONTEXT": true, "KUBECONFIG": true,
	"AWS_PROFILE": true, "AWS_REGION": true, "AWS_DEFAULT_REGION": true, "AWS_CONFIG_FILE": true,
	// The Codex agent's home folder (a path; the login file stays inside it).
	"CODEX_HOME": true,
}

// Always allowed, upper-case prefixes.
var allowPrefixes = []string{"LC_", "XDG_"}

// Allowed by prefix on the original (lower-case) spelling, further checked by
// the stricter npm rule below.
const npmPrefix = "NPM_CONFIG_"

// Names that contain a secret word but only locate a file: allowed before the
// secret-word rule runs.
var allowDespiteWords = map[string]bool{"AWS_SHARED_CREDENTIALS_FILE": true}

// Never allowed (unless the operator names the variable): a name containing any
// of these substrings.
var secretWords = []string{"KEY", "TOKEN", "SECRET", "PASSWORD", "PASSWD", "CREDENTIAL"}

// Never allowed, endpoint overrides (unless the operator names them).
var endpointSuffixes = []string{"_BASE_URL", "_API_BASE"}

// Deny list kept as a second guard. These are never passed, not even by the
// operator allow-list: subscription agents must not see the harness's own
// provider settings (they can push a CLI onto per-token billing or onto a
// mock server) and the router's secrets stay with the router. Declare a
// variable in a manifest's env to pass one on purpose.
var (
	denyPrefixes = []string{
		"ANTHROPIC_", "OPENAI_", "XAI_", "GROK_CODE_", "GEMINI_", "GOOGLE_GENAI_",
		"GOOGLE_API_KEY", "OPENROUTER_", "HARNESS_", "OCTO_ROUTER_",
	}
	denyExact = map[string]bool{"OCTO_KEY": true, "OCTO_HISTORY_TOKEN_KEY": true, "OCTO_CONFIG": true}
)

// Allow is an operator allow-list of exact names and PREFIX_* patterns.
type Allow struct {
	exact    map[string]bool
	prefixes []string
}

// ParseAllow reads "NAME,PREFIX_*" (case-insensitive, blanks ignored). A bare
// "*" is ignored: it would switch the allow-list off.
func ParseAllow(spec string) Allow {
	a := Allow{exact: map[string]bool{}}
	for _, item := range strings.Split(spec, ",") {
		item = strings.ToUpper(strings.TrimSpace(item))
		switch {
		case item == "" || item == "*":
		case strings.HasSuffix(item, "*"):
			a.prefixes = append(a.prefixes, strings.TrimSuffix(item, "*"))
		default:
			a.exact[item] = true
		}
	}
	return a
}

func (a Allow) has(upper string) bool {
	if a.exact[upper] {
		return true
	}
	for _, p := range a.prefixes {
		if strings.HasPrefix(upper, p) {
			return true
		}
	}
	return false
}

// operator is the live operator allow-list. It starts from the process
// environment and is swapped by SetAllow (after harness.env is read, and when
// the settings API changes HARNESS_CHILD_ENV_ALLOW), so it is an atomic pointer.
var operator = func() *atomic.Pointer[Allow] {
	var p atomic.Pointer[Allow]
	a := ParseAllow(os.Getenv(AllowEnvVar))
	p.Store(&a)
	return &p
}()

// SetAllow replaces the operator allow-list with spec ("NAME,PREFIX_*"). Safe
// to call while children are being started; a child already running keeps the
// environment it was given.
func SetAllow(spec string) {
	a := ParseAllow(spec)
	operator.Store(&a)
	if len(a.exact)+len(a.prefixes) > 0 {
		slog.Info("child processes also get these environment variables", "allow", spec)
	}
}

func currentAllow() Allow { return *operator.Load() }

// Scrub returns the entries of environ (KEY=VALUE) a child may see, using the
// operator allow-list read at start-up. The input is not changed.
func Scrub(environ []string) []string { return ScrubWith(environ, currentAllow()) }

// ScrubWith is Scrub with an explicit operator allow-list.
func ScrubWith(environ []string, op Allow) []string {
	out := make([]string, 0, len(environ))
	for _, kv := range environ {
		name, _, ok := strings.Cut(kv, "=")
		if ok && name != "" && permitted(name, op) {
			out = append(out, kv)
		}
	}
	return out
}

func permitted(name string, op Allow) bool {
	upper := strings.ToUpper(name)
	if denied(upper) {
		return false
	}
	if op.has(upper) {
		return true
	}
	if allowDespiteWords[upper] {
		return true
	}
	if upper != "SSH_AUTH_SOCK" && secretLike(upper) {
		return false
	}
	if allowExact[upper] {
		return true
	}
	for _, p := range allowPrefixes {
		if strings.HasPrefix(upper, p) {
			return true
		}
	}
	// npm reads settings as npm_config_*; registry auth lives there too.
	return strings.HasPrefix(upper, npmPrefix) && !strings.Contains(upper, "AUTH")
}

func denied(upper string) bool {
	if denyExact[upper] {
		return true
	}
	for _, p := range denyPrefixes {
		if strings.HasPrefix(upper, p) {
			return true
		}
	}
	return false
}

func secretLike(upper string) bool {
	for _, w := range secretWords {
		if strings.Contains(upper, w) {
			return true
		}
	}
	for _, s := range endpointSuffixes {
		if strings.HasSuffix(upper, s) {
			return true
		}
	}
	return false
}

// Build is the permitted part of environ followed by extra (a manifest's
// resolved env), so extra deliberately wins and can pass a key. The bash tool
// calls it with no extra.
func Build(environ []string, extra map[string]string) []string {
	return BuildWith(environ, extra, currentAllow())
}

// BuildWith is Build with an explicit operator allow-list.
func BuildWith(environ []string, extra map[string]string, op Allow) []string {
	env := ScrubWith(environ, op)
	for k, v := range extra {
		env = append(env, k+"="+v)
	}
	return env
}
