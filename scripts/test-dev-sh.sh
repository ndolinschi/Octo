#!/usr/bin/env bash
# Scripted check of scripts/dev.sh (Linux/macOS): start it in the background, wait for the harness /health and the
# UI dev server, send SIGINT, and assert that no process of the stack is left and the ports are free again.
# With --router (acceptance 8) it also asserts that the router came up, answers /health, that the harness
# reports it in GET /v1/config, and that the router is gone and its port free after SIGINT.
# It first occupies the default bridge port (8790) with a stand-in listener and asserts that dev.sh moves to another
# free port (read from its "ready" block), leaves the stand-in alone, refuses an explicitly requested busy port by
# name, and prints no ERR_PNPM noise on Ctrl+C. Needs python3 for the stand-in listener.
# Usage: scripts/test-dev-sh.sh [--mock] [--router] [--help]    (the flags are passed to dev.sh)
set -euo pipefail

case "${1:-}" in
  -h | --help)
    sed -n '2,9p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The default bridge port is what the test occupies; the ports dev.sh really uses are read from its output.
BUSY_PORT=8790
WANT_ROUTER=0
for a in "$@"; do [[ "$a" == --router ]] && WANT_ROUTER=1; done
unset OCTO_DEV_BRIDGE_PORT OCTO_DEV_ROUTER_PORT OCTO_DEV_MOCK_PORT OCTO_DEV_UI_PORT
LOG="$(mktemp "${TMPDIR:-/tmp}/octo-dev-sh.XXXXXX")"
DATA="$(mktemp -d "${TMPDIR:-/tmp}/octo-dev-sh-data.XXXXXX")"
export HARNESS_DATA_DIR="$DATA"
# The bridge API token dev.sh would generate; fixed here so the checks below can send it.
export HARNESS_API_TOKEN="devsh-test-token-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"

fail() {
  echo "FAIL: $*" >&2
  echo "--- dev.sh output ($LOG) ---" >&2
  tail -n 40 "$LOG" >&2 || true
  exit 1
}

port_in_use() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
for p in $BUSY_PORT 1420 8791 8792; do
  if port_in_use "$p"; then fail "port $p is busy before the test; stop whatever uses it"; fi
done

command -v python3 >/dev/null 2>&1 || fail "python3 is needed for the stand-in listener on port $BUSY_PORT"
# The stand-in: a listener on the default bridge port that must survive the whole run untouched.
python3 -c '
import socket, sys, time
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", int(sys.argv[1]))); s.listen(5); time.sleep(3600)' "$BUSY_PORT" &
OCCUPIER_PID=$!
for _ in $(seq 1 50); do port_in_use "$BUSY_PORT" && break; sleep 0.1; done
port_in_use "$BUSY_PORT" || fail "could not occupy port $BUSY_PORT for the test"

# An explicitly requested busy port is an error that names the port (and the process, where lsof/ss can tell).
if "$ROOT/scripts/dev.sh" --bridge-port "$BUSY_PORT" "$@" >"$LOG" 2>&1; then fail "dev.sh --bridge-port $BUSY_PORT succeeded although the port is busy"; fi
grep -q "port $BUSY_PORT is already in use" "$LOG" || fail "the busy-port error does not name port $BUSY_PORT"
if command -v lsof >/dev/null 2>&1 || command -v ss >/dev/null 2>&1; then
  grep -q "python" "$LOG" || fail "the busy-port error does not name the process holding the port"
fi
echo "ok: an explicit busy bridge port is refused and named"

# Job control gives dev.sh its own process group, so the whole stack can be found and signalled.
set -m
# No built-in agent plugins here: the check must not probe or start any real agent CLI on this machine.
HARNESS_NO_BUILTIN_PLUGINS=1 "$ROOT/scripts/dev.sh" "$@" >"$LOG" 2>&1 &
DEV_PID=$!
set +m

cleanup() {
  kill -KILL -- "-$DEV_PID" 2>/dev/null || true
  kill "$OCCUPIER_PID" 2>/dev/null || true
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

# The ports dev.sh chose, from its "ready" block.
ready_url() { sed -n "s|^  $1  *http://[^:]*:\\([0-9][0-9]*\\).*|\\1|p" "$LOG" | head -n 1; }
BRIDGE_PORT="$(ready_url bridge)"
UI_PORT="$(ready_url UI)"
ROUTER_PORT="$(ready_url router)"
[[ -n "$BRIDGE_PORT" && -n "$UI_PORT" ]] || fail "could not read the chosen ports from the ready block"
[[ "$BRIDGE_PORT" != "$BUSY_PORT" ]] || fail "dev.sh used the busy default bridge port $BUSY_PORT"
PORTS=("$BRIDGE_PORT" "$UI_PORT")
[[ "$WANT_ROUTER" -eq 1 ]] && PORTS+=("$ROUTER_PORT")
grep -q "bridge port $BUSY_PORT is busy" "$LOG" || fail "dev.sh did not say that it moved off port $BUSY_PORT"
echo "ok: the busy default bridge port $BUSY_PORT was skipped; bridge on $BRIDGE_PORT, UI on $UI_PORT"
curl -fsS "http://127.0.0.1:$BRIDGE_PORT/health" >/dev/null || fail "harness /health does not answer"
curl -fsS "http://localhost:$UI_PORT/" >/dev/null || fail "UI dev server does not answer"
echo "ok: harness /health and the UI answer"
code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$BRIDGE_PORT/v1/config")"
[[ "$code" == 401 ]] || fail "harness answered $code (expected 401) to /v1/config without the API token"
code="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $HARNESS_API_TOKEN" "http://127.0.0.1:$BRIDGE_PORT/v1/config")"
[[ "$code" == 200 ]] || fail "harness answered $code (expected 200) to /v1/config with the API token"
echo "ok: the harness enforces the API token on /v1 and /health stays open"
if [[ "$WANT_ROUTER" -eq 1 ]]; then
  health="$(curl -fsS "http://127.0.0.1:$ROUTER_PORT/health")" || fail "router /health does not answer"
  [[ "$health" == *'"service":"octo"'* ]] || fail "port $ROUTER_PORT does not look like the Octo router: $health"
  # Unauthenticated calls are refused: the generated client key is really enforced.
  code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$ROUTER_PORT/autoroute/v1/messages" -d '{}')"
  [[ "$code" == 401 ]] || fail "router answered $code (expected 401) to a call without the client key"
  config="$(curl -fsS -H "Authorization: Bearer $HARNESS_API_TOKEN" "http://127.0.0.1:$BRIDGE_PORT/v1/config")" || fail "harness /v1/config does not answer"
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
port_in_use "$BUSY_PORT" || fail "the stand-in listener on port $BUSY_PORT is gone (dev.sh must not touch it)"
# Nothing the children print while being stopped is an error worth showing.
if grep -n "ERR_PNPM\|Command failed with signal\|ELIFECYCLE" "$LOG"; then fail "termination noise after Ctrl+C (lines above)"; fi
echo "PASS: dev.sh came up, answered, and left no process or port behind after SIGINT"
rm -f "$LOG"
