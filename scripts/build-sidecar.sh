#!/usr/bin/env bash
# Builds the harness for this machine and puts it where Tauri expects the sidecar:
#   apps/desktop/src-tauri/binaries/harness-<host target triple>[.exe]
# Run by `pnpm tauri dev` / `pnpm tauri build` (see tauri.conf.json) and by scripts/install.sh.
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/build-sidecar.sh [--help]

Builds apps/harness (CGO off, stripped) for the host and writes
apps/desktop/src-tauri/binaries/harness-<triple>, the name `bundle.externalBin` needs.
The host triple comes from `rustc -vV`. Needs Go 1.26+ and Rust.
USAGE
}

case "${1:-}" in
  -h | --help) usage; exit 0 ;;
  "") ;;
  *) echo "build-sidecar: unknown argument: $1" >&2; usage >&2; exit 2 ;;
esac

need() { # tool, hint
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "build-sidecar: '$1' is not installed. $2" >&2
    exit 1
  fi
}
need go "Install Go 1.26+ (macOS: brew install go; Linux: bash scripts/install-go-toolchain.sh)."
need rustc "Install Rust from https://rustup.rs (the triple in the sidecar's file name comes from rustc)."

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TRIPLE="$(rustc -vV | sed -n 's/^host: //p')"
if [[ -z "$TRIPLE" ]]; then
  echo "build-sidecar: could not read the host triple from 'rustc -vV'" >&2
  exit 1
fi
EXT=""
case "$TRIPLE" in *windows*) EXT=".exe" ;; esac

OUT_DIR="$ROOT/apps/desktop/src-tauri/binaries"
OUT="$OUT_DIR/harness-$TRIPLE$EXT"
mkdir -p "$OUT_DIR"
echo "build-sidecar: building the harness for $TRIPLE"
(cd "$ROOT/apps/harness" && CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o "$OUT" ./cmd/harness)
echo "build-sidecar: $OUT"
