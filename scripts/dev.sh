#!/usr/bin/env bash
# One command for development: builds and starts the harness (no API key needed) and the UI dev server,
# prints the URL, and stops both (and their children) on Ctrl+C.
set -euo pipefail

BRIDGE_PORT="${OCTO_DEV_BRIDGE_PORT:-8790}"
MOCK_PORT=8791
UI_PORT=1420 # fixed by apps/desktop/vite.config.ts (strictPort)
MOCK=0

usage() {
  cat <<'USAGE'
Usage: scripts/dev.sh [--mock] [--bridge-port PORT] [--help]

Starts, from the repository root:
  1. the harness bridge   (go build, then `harness serve`)   http://127.0.0.1:8790
  2. the UI dev server    (pnpm --filter @octo/desktop dev)  http://localhost:1420

Ctrl+C stops both. Runs `pnpm install` first when node_modules is missing.

  --mock               also start the mock model server (examples/mockllm, port 8791) and point the
                       harness at it with a fake ANTHROPIC_API_KEY (set for this mode only)
  --bridge-port PORT   harness port (default 8790, or $OCTO_DEV_BRIDGE_PORT); the UI is pointed at it
  -h, --help           this text

The harness keeps its data in its default data directory; set HARNESS_DATA_DIR to use another one.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h | --help) usage; exit 0 ;;
    --mock) MOCK=1 ;;
    --bridge-port)
      shift
      BRIDGE_PORT="${1:-}"
      ;;
    *) echo "dev.sh: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done
if ! [[ "$BRIDGE_PORT" =~ ^[0-9]+$ ]]; then
  echo "dev.sh: --bridge-port needs a number (got '$BRIDGE_PORT')" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

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

port_in_use() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
ports=("$BRIDGE_PORT" "$UI_PORT")
[[ "$MOCK" -eq 1 ]] && ports+=("$MOCK_PORT")
for p in "${ports[@]}"; do
  if port_in_use "$p"; then
    echo "dev.sh: port $p is already in use. Stop what is using it (is another dev.sh running?)." >&2
    exit 1
  fi
done

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

# Each background job gets its own process group (job control), so one signal reaches a job's children too.
set -m
PIDS=()
CLEANED=0
cleanup() {
  [[ "$CLEANED" -eq 1 ]] && return
  CLEANED=1
  trap '' INT TERM
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
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ "$MOCK" -eq 1 ]]; then
  "$BIN_DIR/octo-mockllm" &
  PIDS+=("$!")
  for _ in $(seq 1 50); do port_in_use "$MOCK_PORT" && break; sleep 0.2; done
  port_in_use "$MOCK_PORT" || { echo "dev.sh: the mock model server did not start on port $MOCK_PORT" >&2; exit 1; }
  ANTHROPIC_API_KEY=mock "$BIN_DIR/octo-harness" serve --addr "127.0.0.1:$BRIDGE_PORT" --base-url "http://127.0.0.1:$MOCK_PORT" &
else
  "$BIN_DIR/octo-harness" serve --addr "127.0.0.1:$BRIDGE_PORT" &
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

VITE_HARNESS_BRIDGE_URL="http://127.0.0.1:$BRIDGE_PORT" pnpm --filter @octo/desktop dev &
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
