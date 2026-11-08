#!/usr/bin/env bash
# Idempotent Go toolchain for Cloud Agent / CI hosts. Installs into /usr/local/go
# and symlinks binaries into /usr/local/bin so login shells see them.
set -euo pipefail

GO_VERSION="${GO_VERSION:-1.26.0}"
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
  sudo rm -rf /usr/local/go
  sudo tar -C /usr/local -xzf "$tmp/go.tgz"
  rm -rf "$tmp"
fi

sudo ln -sfn /usr/local/go/bin/go /usr/local/bin/go
sudo ln -sfn /usr/local/go/bin/gofmt /usr/local/bin/gofmt
go version
