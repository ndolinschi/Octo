#!/usr/bin/env bash
# The phone's whole flow in a real browser, with no tunnel and no network: a real `harness serve` with the mock model and
# a FAKE cloudflared (apps/harness/internal/remoteaccess/testdata/fake-cloudflared), the built web app (apps/web/dist)
# served by the harness's second listener, and Playwright at 390x700 (scripts/phone-flow.mjs) as the phone. The
# "computer" is curl with the local API token. Usage: bash apps/web/scripts/phone-flow.sh [--out DIR] [--theme dark|light]
# Needs Go, python3, Playwright with Chromium, and `pnpm --filter @octo/web build` first.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
OUT=/tmp/octo-phone-flow
THEME=dark
while [ $# -gt 0 ]; do case "$1" in --out) OUT=$2; shift 2 ;; --theme) THEME=$2; shift 2 ;; *) echo "unknown $1" >&2; exit 2 ;; esac; done
[ -f "$ROOT/apps/web/dist/index.html" ] || { echo "build the web app first: pnpm --filter @octo/web build" >&2; exit 2; }
TMP=$(mktemp -d)
PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; sleep 0.3; rm -rf "$TMP"; }
trap cleanup EXIT
mkdir -p "$TMP/bin" "$OUT"
(cd "$ROOT/apps/harness" && go build -o "$TMP/harness" ./cmd/harness && go build -o "$TMP/mockllm" ./examples/mockllm)
cp "$ROOT/apps/harness/internal/remoteaccess/testdata/fake-cloudflared" "$TMP/bin/cloudflared"
export LOCAL_TOKEN="flow-$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"
"$TMP/mockllm" --addr 127.0.0.1:8851 --delay 40ms >"$TMP/mock.log" 2>&1 & PIDS+=($!)
PATH="$TMP/bin:$PATH" HARNESS_API_TOKEN="$LOCAL_TOKEN" HARNESS_NO_BUILTIN_PLUGINS=1 ANTHROPIC_API_KEY=mock \
  HARNESS_REMOTE_ADDR=127.0.0.1:8853 HARNESS_REMOTE_WEB_DIR="$ROOT/apps/web/dist" \
  "$TMP/harness" serve --addr 127.0.0.1:8852 --data-dir "$TMP/data" --base-url http://127.0.0.1:8851 >"$TMP/harness.log" 2>&1 & PIDS+=($!)
for _ in $(seq 100); do curl -fsS http://127.0.0.1:8852/health >/dev/null 2>&1 && break; sleep 0.2; done
mkdir -p "$TMP/atlas" && printf '# Atlas\n' >"$TMP/atlas/README.md"
export BRIDGE=http://127.0.0.1:8852 PHONE=http://127.0.0.1:8853 PROJECT_DIR="$TMP/atlas"
node "$ROOT/apps/web/scripts/phone-flow.mjs" --out "$OUT" --theme "$THEME" || { tail -30 "$TMP/harness.log"; exit 1; }
