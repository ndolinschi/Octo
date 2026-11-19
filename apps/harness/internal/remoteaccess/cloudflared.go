package remoteaccess

import (
	"context"
	"os/exec"
	"regexp"
	"runtime"
	"strings"
	"time"
)

// EnvCloudflared names the cloudflared binary to use instead of the one on PATH.
const EnvCloudflared = "HARNESS_REMOTE_CLOUDFLARED"

// Cloudflared is what the harness knows about the tunnel program on this machine.
type Cloudflared struct {
	Found   bool   `json:"found"`
	Path    string `json:"path,omitempty"`
	Version string `json:"version,omitempty"`
	// Install is the command (or step) that installs it on this OS.
	Install string `json:"install"`
}

// FindCloudflared looks for the program: configured (a path, or a name looked up on PATH) else "cloudflared" on
// PATH. It asks for the version with a short timeout.
func FindCloudflared(ctx context.Context, configured string) Cloudflared {
	c := Cloudflared{Install: InstallLine(runtime.GOOS, runtime.GOARCH)}
	name := strings.TrimSpace(configured)
	if name == "" {
		name = "cloudflared"
	}
	p, err := exec.LookPath(name)
	if err != nil {
		return c
	}
	c.Found, c.Path = true, p
	vctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	out, err := exec.CommandContext(vctx, p, "--version").CombinedOutput()
	if err == nil {
		c.Version = parseVersion(string(out))
	}
	return c
}

var versionRe = regexp.MustCompile(`(?i)version\s+([0-9][0-9A-Za-z.\-+]*)`)

func parseVersion(out string) string {
	if m := versionRe.FindStringSubmatch(out); m != nil {
		return m[1]
	}
	line, _, _ := strings.Cut(strings.TrimSpace(out), "\n")
	if len(line) > 80 {
		line = line[:80]
	}
	return line
}

// linuxInstall is Cloudflare's own package repository for Debian and Ubuntu
// (developers.cloudflare.com, cloudflared downloads): apt checks each package
// against the repository's signing key. Another distribution follows the
// vendor's downloads page (usererr.CloudflaredMissing names it); an
// unverified release binary is never suggested.
const linuxInstall = "sudo mkdir -p --mode=0755 /usr/share/keyrings && " +
	"curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null && " +
	"echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' | " +
	"sudo tee /etc/apt/sources.list.d/cloudflared.list && sudo apt-get update && sudo apt-get install -y cloudflared"

// InstallLine is the install step shown when cloudflared is missing: a package
// manager that verifies what it installs. The harness never downloads it itself.
func InstallLine(goos, _ string) string {
	switch goos {
	case "darwin":
		return "brew install cloudflared"
	case "windows":
		return "winget install --id Cloudflare.cloudflared"
	default:
		return linuxInstall
	}
}

// quickURL is the public URL of a quick tunnel. cloudflared prints it inside a box on standard error; the exact
// layout is not documented, so any https://<label>.trycloudflare.com anywhere in a line counts, except the API host
// cloudflared itself talks to (it appears in error lines).
var quickURL = regexp.MustCompile(`(https://([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.trycloudflare\.com)(?:[\s/|"']|$)`)

// ParseQuickURL returns the tunnel URL a line of cloudflared's output carries, or "".
func ParseQuickURL(line string) string {
	for _, m := range quickURL.FindAllStringSubmatch(strings.ToLower(line), -1) {
		if m[2] == "api" || m[2] == "www" {
			continue
		}
		return m[1]
	}
	return ""
}

// isRegistered is cloudflared's line for a connection the edge accepted.
func isRegistered(line string) bool {
	return strings.Contains(line, "Registered tunnel connection")
}
