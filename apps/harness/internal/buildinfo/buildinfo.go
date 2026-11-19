// Package buildinfo is the harness's one version number. The build stamps it
// (scripts/build-sidecar.sh, install.sh):
//
//	go build -ldflags "-X github.com/ndolinschi/Octo/apps/harness/internal/buildinfo.Version=0.2.0 \
//	  -X github.com/ndolinschi/Octo/apps/harness/internal/buildinfo.Commit=$(git rev-parse --short HEAD)"
//
// Without it, Version is the default below (kept equal to apps/router/Cargo.toml,
// apps/desktop/package.json, tauri.conf.json and the shell's Cargo.toml; a test
// checks) and Commit is read from the Go toolchain's VCS stamp when there is one.
package buildinfo

import "runtime/debug"

// DefaultVersion is the version of this source tree.
const DefaultVersion = "0.2.0"

// Version and Commit can be set with -ldflags -X.
var (
	Version = DefaultVersion
	Commit  = ""
)

// CommitOrVCS is Commit, else the short revision `go build` recorded (with
// "-dirty" for a modified tree), else "".
func CommitOrVCS() string {
	if Commit != "" {
		return Commit
	}
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return ""
	}
	rev, dirty := "", false
	for _, s := range info.Settings {
		switch s.Key {
		case "vcs.revision":
			rev = s.Value
		case "vcs.modified":
			dirty = s.Value == "true"
		}
	}
	if len(rev) > 12 {
		rev = rev[:12]
	}
	if rev != "" && dirty {
		rev += "-dirty"
	}
	return rev
}

// String is "0.2.0" or "0.2.0 (abc123def456)".
func String() string {
	if c := CommitOrVCS(); c != "" {
		return Version + " (" + c + ")"
	}
	return Version
}
