#!/usr/bin/env bash
# Idempotent Go toolchain for Cloud Agent / CI hosts. Installs into /usr/local/go
# and symlinks binaries into /usr/local/bin so login shells see them.
set -euo pipefail

# Keep in step with the `toolchain` line of apps/harness/go.mod.
GO_VERSION="${GO_VERSION:-1.26.11}"
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64) GOARCH=amd64 ;;
  aarch64|arm64) GOARCH=arm64 ;;
  *) echo "unsupported arch: $ARCH" >&2; exit 1 ;;
esac

need_install=1
if command -v go >/dev/null 2>&1; then
  cur="$(go env GOVERSION 2>/dev/null || true)"
  if [[ "$cur" == "go${GO_VERSION}" ]]; then
    need_install=0
  fi
fi

if [[ "$need_install" -eq 1 ]]; then
  tmp="$(mktemp -d)"
  url="https://go.dev/dl/go${GO_VERSION}.linux-${GOARCH}.tar.gz"
  curl -fsSL "$url" -o "$tmp/go.tgz"
  # Verify the tarball against the checksum Go publishes next to it before
  # anything is extracted as root.
  # (go.dev/dl answers *.sha256 with an HTML page; the file itself is on dl.google.com.)
  want="$(curl -fsSL "https://dl.google.com/go/go${GO_VERSION}.linux-${GOARCH}.tar.gz.sha256" | tr -d '[:space:]')"
  if [[ ! "$want" =~ ^[0-9a-f]{64}$ ]]; then
    echo "could not fetch the published SHA-256 for go${GO_VERSION}" >&2
    rm -rf "$tmp"
    exit 1
  fi
  got="$(sha256sum "$tmp/go.tgz" | cut -d' ' -f1)"
  if [[ "$got" != "$want" ]]; then
    echo "SHA-256 mismatch for $url: got $got, want $want" >&2
    rm -rf "$tmp"
    exit 1
  fi
  sudo rm -rf /usr/local/go
  sudo tar -C /usr/local -xzf "$tmp/go.tgz"
  rm -rf "$tmp"
fi

sudo ln -sfn /usr/local/go/bin/go /usr/local/bin/go
sudo ln -sfn /usr/local/go/bin/gofmt /usr/local/bin/gofmt
go version
