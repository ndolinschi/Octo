#!/usr/bin/env bash
# One command for development: builds and starts the harness (no API key needed) and the UI dev server,
# prints the URL, and stops both (and their children) on Ctrl+C. With --router the Octo router runs in front of
# the harness the way the desktop app runs it (design P8).
set -euo pipefail

# Default ports. A default that is busy is replaced by the next free port; a port asked for explicitly (flag or
# environment variable) that is busy is an error.
# OCTO_DEV_PORT_BASE=N moves the four defaults to N (bridge), N+1 (mock), N+2 (router), N+3 (UI); they stay defaults
# (a busy one is replaced), which scripts/test-dev-sh.sh uses to keep clear of a running stack.
BASE="${OCTO_DEV_PORT_BASE:-}"
if [[ -n "$BASE" && ! "$BASE" =~ ^[0-9]+$ ]]; then echo "dev.sh: OCTO_DEV_PORT_BASE needs a number (got '$BASE')" >&2; exit 2; fi
BRIDGE_PORT="${OCTO_DEV_BRIDGE_PORT:-${BASE:-8790}}"; BRIDGE_EXPLICIT=0; [[ -n "${OCTO_DEV_BRIDGE_PORT:-}" ]] && BRIDGE_EXPLICIT=1
MOCK_PORT="${OCTO_DEV_MOCK_PORT:-${BASE:+$((BASE + 1))}}"; MOCK_PORT="${MOCK_PORT:-8791}"; MOCK_EXPLICIT=0; [[ -n "${OCTO_DEV_MOCK_PORT:-}" ]] && MOCK_EXPLICIT=1
ROUTER_PORT="${OCTO_DEV_ROUTER_PORT:-${BASE:+$((BASE + 2))}}"; ROUTER_PORT="${ROUTER_PORT:-8792}"; ROUTER_EXPLICIT=0; [[ -n "${OCTO_DEV_ROUTER_PORT:-}" ]] && ROUTER_EXPLICIT=1
UI_PORT="${OCTO_DEV_UI_PORT:-${BASE:+$((BASE + 3))}}"; UI_PORT="${UI_PORT:-1420}"; UI_EXPLICIT=0; [[ -n "${OCTO_DEV_UI_PORT:-}" ]] && UI_EXPLICIT=1 # read by apps/desktop/vite.config.ts
ROUTER=0
MOCK=0

usage() {
  cat <<'USAGE'
Usage: scripts/dev.sh [--mock] [--router] [--bridge-port PORT] [--help]

Starts, from the repository root:
  1. the harness bridge   (go build, then `harness serve`)   http://127.0.0.1:8790
  2. the UI dev server    (pnpm --filter @octo/desktop dev)  http://localhost:1420
  with --router, before the harness:
     the Octo router     (cargo build -p octo, then the binary) http://127.0.0.1:8792

The addresses above are the defaults. When a default port is busy the next free port is used instead, and the
final "ready" block lists the addresses actually chosen (the UI is pointed at the chosen bridge through
VITE_HARNESS_BRIDGE_URL). A port you ask for explicitly (--bridge-port, or $OCTO_DEV_BRIDGE_PORT,
$OCTO_DEV_ROUTER_PORT, $OCTO_DEV_MOCK_PORT, $OCTO_DEV_UI_PORT) is never replaced: if it is busy, dev.sh stops and
names the process that holds it.

$OCTO_DEV_PORT_BASE=N moves all four defaults to N, N+1 (mock), N+2 (router), N+3 (UI); they are still defaults.
A leading `--` is ignored, so `pnpm dev:all -- --mock` and `pnpm dev:all --mock` both work.

Ctrl+C stops everything. Runs `pnpm install` first when node_modules is missing.

  --mock               also start the mock model server (examples/mockllm, port 8791) and point the
                       harness at it with a fake ANTHROPIC_API_KEY (set for this mode only)
  --router             also start the Octo router (apps/router) on 127.0.0.1:8792 (or $OCTO_DEV_ROUTER_PORT) with a
                       generated client key, and start the harness with --base-url http://127.0.0.1:8792/autoroute.
                       Needs an upstream key in $OCTO_ROUTER_UPSTREAM_KEY (or $OPENROUTER_API_KEY), or --mock, where
                       the router's upstream is the mock model server instead of OpenRouter. The router keeps its
                       history database under ${OCTO_DEV_ROUTER_DIR:-~/.local/share/octo-dev/router} (a temporary
                       directory with --mock); its log goes to router.log there.
  --bridge-port PORT   harness port (default 8790, or $OCTO_DEV_BRIDGE_PORT); the UI is pointed at it
  -h, --help           this text

The harness requires a bridge API token (HARNESS_API_TOKEN) on /v1: dev.sh generates one per run, or uses the
HARNESS_API_TOKEN you export, and gives it to the harness and to the UI dev server.
The harness keeps its data in its default data directory; set HARNESS_DATA_DIR to use another one.
USAGE
}

# `pnpm dev:all -- --mock` hands the literal `--` on (pnpm 10): skip a leading one.
if [[ "${1:-}" == -- ]]; then shift; fi
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h | --help) usage; exit 0 ;;
    --mock) MOCK=1 ;;
    --router) ROUTER=1 ;;
    --bridge-port)
      shift
      BRIDGE_PORT="${1:-}"
      BRIDGE_EXPLICIT=1
      ;;
    *) echo "dev.sh: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done
for pair in "bridge port:$BRIDGE_PORT" "router port:$ROUTER_PORT" "mock port:$MOCK_PORT" "UI port:$UI_PORT"; do
  if ! [[ "${pair#*:}" =~ ^[0-9]+$ ]]; then
    echo "dev.sh: the ${pair%%:*} needs a number (got '${pair#*:}')" >&2
    exit 2
  fi
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

UPSTREAM_KEY="${OCTO_ROUTER_UPSTREAM_KEY:-${OPENROUTER_API_KEY:-}}"
if [[ "$ROUTER" -eq 1 && "$MOCK" -eq 0 && -z "$UPSTREAM_KEY" ]]; then
  echo "dev.sh: --router needs an upstream key: set OCTO_ROUTER_UPSTREAM_KEY (or OPENROUTER_API_KEY), or add --mock." >&2
  exit 2
fi

need() { # tool, hint
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "dev.sh: '$1' is not installed. $2" >&2
    exit 1
  fi
}
need go "Install Go 1.26+ (macOS: brew install go; Linux: bash scripts/install-go-toolchain.sh)."
need pnpm "Install pnpm 10+ (corepack enable, or npm install -g pnpm)."
need node "Install Node.js 22+ (https://nodejs.org or your version manager)."
need curl "Install curl with your package manager."
[[ "$ROUTER" -eq 1 ]] && need cargo "Install Rust from https://rustup.rs (the router is built from apps/router)."

port_in_use() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

# Who listens on a port, as far as the machine will tell us (lsof, then ss); empty when unknown.
port_owner() {
  local out=""
  if command -v lsof >/dev/null 2>&1; then
    out="$(lsof -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | awk 'NR==2 {print $1 " (pid " $2 ")"}')"
  fi
  if [[ -z "$out" ]] && command -v ss >/dev/null 2>&1; then
    out="$(ss -ltnp "sport = :$1" 2>/dev/null | sed -n 's/.*users:(("\([^"]*\)",pid=\([0-9]*\).*/\1 (pid \2)/p' | head -n 1)"
  fi
  printf '%s' "$out"
}

# Port selection. Explicit ports must be free; defaults that are free are kept; busy defaults move to the next free
# port that is neither busy nor wanted by another service here.
RESERVED=" "
NOTES=()
reserve_port() { RESERVED="$RESERVED$1 "; }
port_reserved() { [[ "$RESERVED" == *" $1 "* ]]; }
choose_ports() { # entries "VAR:label:explicit"
  local entry var label explicit cur owner
  for entry in "$@"; do
    IFS=: read -r var label explicit <<<"$entry"
    cur="${!var}"
    if port_in_use "$cur"; then
      if [[ "$explicit" -eq 1 ]]; then
        owner="$(port_owner "$cur")"
        echo "dev.sh: the $label port $cur is already in use${owner:+ by $owner}. Stop it, or choose another port." >&2
        exit 1
      fi
      continue # a busy default: second pass
    fi
    reserve_port "$cur"
  done
  for entry in "$@"; do
    IFS=: read -r var label explicit <<<"$entry"
    cur="${!var}"
    port_reserved "$cur" && continue
    local next=$((cur + 1)) tries=0
    while { port_in_use "$next" || port_reserved "$next"; } && [[ $tries -lt 200 ]]; do
      next=$((next + 1))
      tries=$((tries + 1))
    done
    owner="$(port_owner "$cur")"
    NOTES+=("$label port $cur is busy${owner:+ ($owner)}; using $next")
    printf -v "$var" '%s' "$next"
    reserve_port "$next"
  done
}
SPECS=("BRIDGE_PORT:bridge:$BRIDGE_EXPLICIT" "UI_PORT:UI:$UI_EXPLICIT")
[[ "$MOCK" -eq 1 ]] && SPECS+=("MOCK_PORT:mock:$MOCK_EXPLICIT")
[[ "$ROUTER" -eq 1 ]] && SPECS+=("ROUTER_PORT:router:$ROUTER_EXPLICIT")
choose_ports "${SPECS[@]}"
if [[ ${#NOTES[@]} -gt 0 ]]; then
  for n in "${NOTES[@]}"; do echo "dev.sh: $n"; done
fi

cd "$ROOT"
if [[ ! -d node_modules ]]; then
  echo "dev.sh: installing JavaScript dependencies (pnpm install)"
  pnpm install
fi

BIN_DIR="$ROOT/apps/harness"
echo "dev.sh: building the harness"
(cd "$BIN_DIR" && go build -o octo-harness ./cmd/harness)
if [[ "$MOCK" -eq 1 ]]; then
  (cd "$BIN_DIR" && go build -o octo-mockllm ./examples/mockllm)
fi

ROUTER_TMP=""
ROUTER_DIR=""
ROUTER_BIN=""
if [[ "$ROUTER" -eq 1 ]]; then
  echo "dev.sh: building the router (cargo build -p octo)"
  (cd "$ROOT" && cargo build -p octo)
  ROUTER_BIN="$ROOT/target/debug/octo"
  [[ -x "$ROUTER_BIN" ]] || { echo "dev.sh: the router build finished but $ROUTER_BIN is missing" >&2; exit 1; }
  if [[ "$MOCK" -eq 1 ]]; then
    ROUTER_TMP="$(mktemp -d "${TMPDIR:-/tmp}/octo-dev-router.XXXXXX")"
    ROUTER_DIR="$ROUTER_TMP"
  else
    ROUTER_DIR="${OCTO_DEV_ROUTER_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/octo-dev/router}"
  fi
  mkdir -p "$ROUTER_DIR/config"
  # The same three fragments the desktop shell writes (apps/desktop/src-tauri/sidecar/src/router.rs); the key is
  # random per run and lives in a 0600 file, never on a command line.
  CLIENT_KEY="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
  (umask 077; printf '[server]\nbind_addr = "127.0.0.1:%s"\nallow_remote = false\nclient_auth_key = "%s"\n' "$ROUTER_PORT" "$CLIENT_KEY" >"$ROUTER_DIR/config/server.toml")
  printf '[limits]\nmax_body_bytes = 33554432\n' >"$ROUTER_DIR/config/limits.toml"
  printf '[history]\ndatabase_path = "%s/history.sqlite"\n' "$ROUTER_DIR" >"$ROUTER_DIR/config/history.toml"
  rm -f "$ROUTER_DIR/config/openrouter.toml"
  if [[ "$MOCK" -eq 1 ]]; then
    # Router -> mock model, as apps/harness/scripts/e2e-router.sh wires it.
    printf '[openrouter]\nmessages_url = "http://127.0.0.1:%s/v1/messages"\ndecisions_url = "http://127.0.0.1:%s/decisions"\n' "$MOCK_PORT" "$MOCK_PORT" >"$ROUTER_DIR/config/openrouter.toml"
  fi
fi

# Each background job gets its own process group (job control), so one signal reaches a job's children too.
set -m
PIDS=()
CLEANED=0
# Created the moment this script starts stopping its children. Output the children print after that (pnpm's
# ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL, "Command failed with signal SIGTERM", shutdown lines) is the expected result
# of our own signal and is dropped; everything printed before it, including every real error, is shown.
STOP_MARK="$(mktemp -u "${TMPDIR:-/tmp}/octo-dev-stop.XXXXXX")"
quiet_after_stop() {
  local line
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -e "$STOP_MARK" ]] || printf '%s\n' "$line"
  done
}
# bg_quiet CMD ARGS...: run in the background (own process group), output filtered by quiet_after_stop.
bg_quiet() {
  "$@" > >(quiet_after_stop) 2> >(quiet_after_stop >&2) &
}
cleanup() {
  [[ "$CLEANED" -eq 1 ]] && return
  CLEANED=1
  trap '' INT TERM
  : >"$STOP_MARK"
  local pid
  if [[ ${#PIDS[@]} -gt 0 ]]; then
    echo
    echo "dev.sh: stopping"
    for pid in "${PIDS[@]}"; do kill -TERM -- "-$pid" 2>/dev/null || true; done
    local i
    for i in 1 2 3 4 5 6; do # up to 3 s
      local alive=0
      for pid in "${PIDS[@]}"; do kill -0 -- "-$pid" 2>/dev/null && alive=1; done
      [[ "$alive" -eq 0 ]] && break
      sleep 0.5
    done
    for pid in "${PIDS[@]}"; do kill -KILL -- "-$pid" 2>/dev/null || true; done
    for pid in "${PIDS[@]}"; do wait "$pid" 2>/dev/null || true; done
  fi
}
trap 'exit 130' INT
trap 'exit 143' TERM
cleanup_router_tmp() { [[ -n "$ROUTER_TMP" ]] && rm -rf "$ROUTER_TMP"; return 0; }
cleanup_all() { cleanup; cleanup_router_tmp; rm -f "$STOP_MARK"; }
trap cleanup_all EXIT

if [[ "$MOCK" -eq 1 ]]; then
  bg_quiet "$BIN_DIR/octo-mockllm" --addr "127.0.0.1:$MOCK_PORT"
  PIDS+=("$!")
  for _ in $(seq 1 50); do port_in_use "$MOCK_PORT" && break; sleep 0.2; done
  port_in_use "$MOCK_PORT" || { echo "dev.sh: the mock model server did not start on port $MOCK_PORT" >&2; exit 1; }
fi

# One bridge API token per run (HARNESS_API_TOKEN from the caller wins, so a script can know it): the harness
# requires it on /v1, the UI dev server sends it (VITE_HARNESS_API_TOKEN). It travels in the environment only.
API_TOKEN="${HARNESS_API_TOKEN:-$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')}"
export HARNESS_API_TOKEN="$API_TOKEN"

HARNESS_ARGS=(serve --addr "127.0.0.1:$BRIDGE_PORT")
# The bridge answers CORS for the UI's own origin only (bridge.DefaultUIOrigins); the dev server may have moved port.
export HARNESS_UI_ORIGINS="http://localhost:$UI_PORT,http://127.0.0.1:$UI_PORT"
if [[ "$ROUTER" -eq 1 ]]; then
  # The router first, then the harness behind it. Like the app, the router needs only OCTO_CONFIG; it forwards the
  # caller's credential upstream, so the harness's API key IS the upstream key, and the router's own gate is the client key.
  OCTO_CONFIG="$ROUTER_DIR/config" "$ROUTER_BIN" >"$ROUTER_DIR/router.log" 2>&1 &
  PIDS+=("$!")
  ROUTER_PID="$!"
  router_up=0
  for _ in $(seq 1 100); do # 20 s
    if curl -fsS -o /dev/null "http://127.0.0.1:$ROUTER_PORT/health" 2>/dev/null; then router_up=1; break; fi
    if ! kill -0 "$ROUTER_PID" 2>/dev/null; then break; fi
    sleep 0.2
  done
  if [[ "$router_up" -ne 1 ]]; then
    echo "dev.sh: the router did not come up on port $ROUTER_PORT; the end of $ROUTER_DIR/router.log:" >&2
    tail -n 20 "$ROUTER_DIR/router.log" >&2 || true
    exit 1
  fi
  HARNESS_ARGS+=(--base-url "http://127.0.0.1:$ROUTER_PORT/autoroute")
  if [[ "$MOCK" -eq 1 ]]; then HARNESS_UPSTREAM=mock; else HARNESS_UPSTREAM="$UPSTREAM_KEY"; fi
  bg_quiet env HARNESS_OCTO_KEY="$CLIENT_KEY" ANTHROPIC_API_KEY="$HARNESS_UPSTREAM" "$BIN_DIR/octo-harness" "${HARNESS_ARGS[@]}"
elif [[ "$MOCK" -eq 1 ]]; then
  bg_quiet env ANTHROPIC_API_KEY=mock "$BIN_DIR/octo-harness" "${HARNESS_ARGS[@]}" --base-url "http://127.0.0.1:$MOCK_PORT"
else
  bg_quiet "$BIN_DIR/octo-harness" "${HARNESS_ARGS[@]}"
fi
PIDS+=("$!")
HARNESS_PID="$!"

healthy=0
for _ in $(seq 1 100); do # 20 s
  if curl -fsS -o /dev/null "http://127.0.0.1:$BRIDGE_PORT/health" 2>/dev/null; then healthy=1; break; fi
  if ! kill -0 "$HARNESS_PID" 2>/dev/null; then
    echo "dev.sh: the harness exited during start-up (its output is above)." >&2
    exit 1
  fi
  sleep 0.2
done
if [[ "$healthy" -ne 1 ]]; then
  echo "dev.sh: the harness did not answer http://127.0.0.1:$BRIDGE_PORT/health within 20 s" >&2
  exit 1
fi

bg_quiet env VITE_HARNESS_BRIDGE_URL="http://127.0.0.1:$BRIDGE_PORT" VITE_HARNESS_API_TOKEN="$API_TOKEN" OCTO_DEV_UI_PORT="$UI_PORT" pnpm --filter @octo/desktop dev
PIDS+=("$!")
UI_PID="$!"

for _ in $(seq 1 150); do # 30 s
  if curl -fsS -o /dev/null "http://localhost:$UI_PORT/" 2>/dev/null; then break; fi
  if ! kill -0 "$UI_PID" 2>/dev/null; then
    echo "dev.sh: the UI dev server exited during start-up (its output is above)." >&2
    exit 1
  fi
  sleep 0.2
done

echo
echo "dev.sh: ready"
echo "  UI      http://localhost:$UI_PORT"
echo "  bridge  http://127.0.0.1:$BRIDGE_PORT"
[[ "$MOCK" -eq 1 ]] && echo "  mock    http://127.0.0.1:$MOCK_PORT"
[[ "$ROUTER" -eq 1 ]] && echo "  router  http://127.0.0.1:$ROUTER_PORT/autoroute   (log: $ROUTER_DIR/router.log)"
if [[ ${#NOTES[@]} -gt 0 ]]; then
  for n in "${NOTES[@]}"; do echo "  note    $n"; done
fi
echo "  Ctrl+C to stop"

while true; do
  for pid in "${PIDS[@]}"; do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "dev.sh: a child process (pid $pid) exited; stopping the rest" >&2
      exit 1
    fi
  done
  sleep 1 &
  wait $! || true # a trapped signal interrupts wait, so Ctrl+C is handled at once
done
