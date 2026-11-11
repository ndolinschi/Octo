#!/usr/bin/env bash
# Scripted check of scripts/dev.sh (Linux/macOS): start it in the background, wait for the harness /health and the
# UI dev server, send SIGINT, and assert that no process of the stack is left and the ports are free again.
# With --router (acceptance 8) it also asserts that the router came up, answers /health, that the harness
# reports it in GET /v1/config, and that the router is gone and its port free after SIGINT.
# Usage: scripts/test-dev-sh.sh [--mock] [--router] [--help]    (the flags are passed to dev.sh)
set -euo pipefail

case "${1:-}" in
  -h | --help)
    sed -n '2,6p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRIDGE_PORT="${OCTO_DEV_BRIDGE_PORT:-8790}"
UI_PORT=1420
ROUTER_PORT="${OCTO_DEV_ROUTER_PORT:-8792}"
WANT_ROUTER=0
for a in "$@"; do [[ "$a" == --router ]] && WANT_ROUTER=1; done
PORTS=("$BRIDGE_PORT" "$UI_PORT")
[[ "$WANT_ROUTER" -eq 1 ]] && PORTS+=("$ROUTER_PORT")
LOG="$(mktemp "${TMPDIR:-/tmp}/octo-dev-sh.XXXXXX")"
DATA="$(mktemp -d "${TMPDIR:-/tmp}/octo-dev-sh-data.XXXXXX")"
export HARNESS_DATA_DIR="$DATA"

fail() {
  echo "FAIL: $*" >&2
  echo "--- dev.sh output ($LOG) ---" >&2
  tail -n 40 "$LOG" >&2 || true
  exit 1
}

port_in_use() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
for p in "${PORTS[@]}"; do
  if port_in_use "$p"; then fail "port $p is busy before the test; stop whatever uses it"; fi
done

# Job control gives dev.sh its own process group, so the whole stack can be found and signalled.
set -m
# No built-in agent plugins here: the check must not probe or start any real agent CLI on this machine.
HARNESS_NO_BUILTIN_PLUGINS=1 "$ROOT/scripts/dev.sh" "$@" >"$LOG" 2>&1 &
DEV_PID=$!
set +m

cleanup() {
  kill -KILL -- "-$DEV_PID" 2>/dev/null || true
  rm -rf "$DATA"
}
trap cleanup EXIT

# Everything started by dev.sh (harness, mock, pnpm/vite) is a descendant; record them as they appear.
descendants() { # pid -> all descendant pids
  local p
  for p in $(pgrep -P "$1" 2>/dev/null || true); do
    echo "$p"
    descendants "$p"
  done
}
SEEN=""
note_processes() { SEEN="$SEEN $(descendants "$DEV_PID" | tr '\n' ' ')"; }

# Cold start may build the harness and run pnpm install: allow 5 minutes.
deadline=$((SECONDS + 300))
until grep -q "dev.sh: ready" "$LOG"; do
  kill -0 "$DEV_PID" 2>/dev/null || fail "dev.sh exited before it was ready"
  [[ $SECONDS -lt $deadline ]] || fail "dev.sh was not ready within 5 minutes"
  note_processes
  sleep 1
done
note_processes

curl -fsS "http://127.0.0.1:$BRIDGE_PORT/health" >/dev/null || fail "harness /health does not answer"
curl -fsS "http://localhost:$UI_PORT/" >/dev/null || fail "UI dev server does not answer"
echo "ok: harness /health and the UI answer"
if [[ "$WANT_ROUTER" -eq 1 ]]; then
  health="$(curl -fsS "http://127.0.0.1:$ROUTER_PORT/health")" || fail "router /health does not answer"
  [[ "$health" == *'"service":"octo"'* ]] || fail "port $ROUTER_PORT does not look like the Octo router: $health"
  # Unauthenticated calls are refused: the generated client key is really enforced.
  code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$ROUTER_PORT/autoroute/v1/messages" -d '{}')"
  [[ "$code" == 401 ]] || fail "router answered $code (expected 401) to a call without the client key"
  config="$(curl -fsS "http://127.0.0.1:$BRIDGE_PORT/v1/config")" || fail "harness /v1/config does not answer"
  [[ "$config" == *'"router":true'* ]] || fail "the harness did not detect the router: $config"
  echo "ok: the router answers, enforces its client key, and the harness is behind it"
fi
[[ -n "${SEEN// /}" ]] || fail "found no child processes of dev.sh (is job control working?)"

kill -INT -- "-$DEV_PID"
deadline=$((SECONDS + 15))
while kill -0 "$DEV_PID" 2>/dev/null; do
  [[ $SECONDS -lt $deadline ]] || fail "dev.sh is still running 15 s after SIGINT"
  sleep 0.2
done
wait "$DEV_PID" 2>/dev/null || true
sleep 0.5

left=""
for p in $SEEN; do
  # a zombie is not running: ignore state Z (sandboxes without an init that reaps)
  state="$(ps -o stat= -p "$p" 2>/dev/null | tr -d ' ' || true)"
  if [[ -n "$state" && "$state" != Z* ]]; then left="$left $p($(ps -o comm= -p "$p" 2>/dev/null || true))"; fi
done
[[ -z "$left" ]] || fail "processes still running after Ctrl+C:$left"
for p in "${PORTS[@]}"; do
  if port_in_use "$p"; then fail "port $p still answers after Ctrl+C"; fi
done
echo "PASS: dev.sh came up, answered, and left no process or port behind after SIGINT"
rm -f "$LOG"
