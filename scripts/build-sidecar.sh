#!/usr/bin/env bash
# Builds the sidecars for this machine and puts them where Tauri expects them:
#   apps/desktop/src-tauri/binaries/harness-<host target triple>[.exe]   (apps/harness, Go)
#   apps/desktop/src-tauri/binaries/octo-<host target triple>[.exe]      (the Octo router, Rust; --no-router skips it)
#   apps/web/dist                                                       (the phone web client, @octo/web; --no-web skips it)
# Run by `pnpm tauri dev` / `pnpm tauri build` (see tauri.conf.json) and by scripts/install.sh.
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/build-sidecar.sh [--no-router] [--no-web] [--help]

Builds apps/harness (CGO off, stripped) for the host and writes
apps/desktop/src-tauri/binaries/harness-<triple>, the name `bundle.externalBin` needs.
Then builds the Octo router (`cargo build --release -p octo` from the repository root) and writes
apps/desktop/src-tauri/binaries/octo-<triple>.
The host triple comes from `rustc -vV`. Needs Go 1.26+ and Rust.

  --no-router   skip the router build (also: OCTO_NO_ROUTER=1). `tauri-build` still needs the file, so a
                placeholder script is written when no router binary is there yet; the app then shows a
                "router did not start" notice if someone switches the router on. Never use it for a release build.
  --no-web      skip building the phone web client (`pnpm --filter @octo/web build` -> apps/web/dist, which the
                app bundles as a resource and the shell passes to the harness as HARNESS_REMOTE_WEB_DIR). `tauri-build`
                still needs the directory, so an empty one (with a .not-built note) is created; the app then says in
                `harness doctor` that the phone client is not available. Never use it for a release build.
USAGE
}

ROUTER=1
WEB=1
[[ "${OCTO_NO_ROUTER:-0}" == 1 ]] && ROUTER=0
[[ "${OCTO_NO_WEB:-0}" == 1 ]] && WEB=0
for arg in "$@"; do
  case "$arg" in
    -h | --help) usage; exit 0 ;;
    --no-router) ROUTER=0 ;;
    --no-web) WEB=0 ;;
    *) echo "build-sidecar: unknown argument: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

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
# One version for the app, the harness and the router (the router's comes from its Cargo.toml, kept equal by
# buildinfo's TestOneVersionEverywhere); the harness also gets the git commit (`harness --version`, GET /health).
VERSION="$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$ROOT/apps/desktop/package.json" | head -1)"
COMMIT="$(git -C "$ROOT" rev-parse --short=12 HEAD 2>/dev/null || true)"
BUILDINFO=github.com/ndolinschi/Octo/apps/harness/internal/buildinfo
echo "build-sidecar: building the harness $VERSION ${COMMIT:+($COMMIT) }for $TRIPLE"
(cd "$ROOT/apps/harness" && CGO_ENABLED=0 go build -trimpath \
  -ldflags "-s -w -X $BUILDINFO.Version=$VERSION -X $BUILDINFO.Commit=$COMMIT" -o "$OUT" ./cmd/harness)
echo "build-sidecar: $OUT"

# --- the router ---------------------------------------------------------------------------------------------------
ROUTER_OUT="$OUT_DIR/octo-$TRIPLE$EXT"
placeholder() { # tauri-build needs the file to exist; a real binary is never overwritten by this
  if [[ ! -f "$ROUTER_OUT" ]]; then
    printf '#!/bin/sh\necho "The Octo router was not built (scripts/build-sidecar.sh --no-router). Run scripts/build-sidecar.sh to build it." >&2\nexit 1\n' >"$ROUTER_OUT"
    chmod +x "$ROUTER_OUT"
    echo "build-sidecar: wrote a placeholder at $ROUTER_OUT (the router is not built; the app will say so if it is switched on)"
  fi
}
if [[ "$ROUTER" -eq 0 ]]; then
  echo "build-sidecar: skipping the router (--no-router)"
  placeholder
elif ! command -v cargo >/dev/null 2>&1; then
  echo "build-sidecar: 'cargo' is not installed, so the router cannot be built. Install Rust from https://rustup.rs, or pass --no-router." >&2
  exit 1
else
  echo "build-sidecar: building the router (cargo build --release -p octo) for $TRIPLE"
  (cd "$ROOT" && cargo build --release -p octo)
  BUILT="$ROOT/target/release/octo$EXT"
  if [[ ! -f "$BUILT" ]]; then
    echo "build-sidecar: the router build finished but $BUILT does not exist" >&2
    exit 1
  fi
  cp -f "$BUILT" "$ROUTER_OUT"
  chmod +x "$ROUTER_OUT"
  echo "build-sidecar: $ROUTER_OUT"
fi

# --- the phone web client -------------------------------------------------------------------------------------------
# tauri.conf.json bundles apps/web/dist as the resource "web-client"; the shell hands it to the harness
# (HARNESS_REMOTE_WEB_DIR) unless harness.env sets one. The directory must exist for tauri-build.
WEB_DIST="$ROOT/apps/web/dist"
if [[ "$WEB" -eq 1 ]]; then
  need pnpm "Install pnpm 10+ (corepack enable, or npm install -g pnpm), or pass --no-web."
  echo "build-sidecar: building the phone web client (pnpm --filter @octo/web build)"
  (cd "$ROOT" && pnpm --filter @octo/web build)
  if [[ ! -f "$WEB_DIST/index.html" ]]; then
    echo "build-sidecar: the web build finished but $WEB_DIST/index.html does not exist" >&2
    exit 1
  fi
else
  echo "build-sidecar: skipping the phone web client (--no-web)"
  if [[ ! -d "$WEB_DIST" ]]; then
    mkdir -p "$WEB_DIST"
    echo "The phone web client was not built (scripts/build-sidecar.sh --no-web)." >"$WEB_DIST/.not-built"
  fi
fi
